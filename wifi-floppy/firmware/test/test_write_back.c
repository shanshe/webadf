#include "harness.h"
#include "../src/write_back.h"
#include "../src/mfm.h"
#include "../src/flux_bits.h"
#include "../src/psram_image.h"
#include "../src/track_cache.h"
#include "../src/adf_mfm.h"
#include "hd_fixture.h"
#include <stdlib.h>
#include <string.h>

/*
 * Write-back piece 1: whether a captured write may touch the disk, and what
 * applying one does. The capture-shaped test drives the same chain the
 * board runs -- flux intervals -> bits -> sectors -> verdict -> encode ->
 * PSRAM -> served track -- and checks the Amiga would read back exactly what
 * it wrote.
 */

#define CELL_NS 2000u

static mfm_decode_result_t whole(int track) {
    mfm_decode_result_t d;
    memset(&d, 0, sizeof d);
    d.found = 0x7ff; d.track_no = (uint8_t)track; d.track_no_consistent = true;
    return d;
}

static int32_t mounted_token(void) {
    psram_publish_slot(0);
    return psram_active_token();
}

static void verdict_applies_a_whole_clean_track(void) {
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_APPLY);
}

static void verdict_rejects_each_fault(void) {
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);

    CHECK_EQ_INT(write_back_verdict(&d, 80, true, tok, tok), WB_REJECT_OVERFLOW);

    d.found = 0x7fe;                        // sector 0 missing
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    d.found = 0x3ff;                        // the last sector missing (2026-09-15's bug)
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);

    d = whole(80); d.track_no_consistent = false;
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_INCONSISTENT);

    d = whole(69);                          // "track says 69, head is on 70"
    CHECK_EQ_INT(write_back_verdict(&d, 70, false, tok, tok), WB_REJECT_WRONG_TRACK);
}

static void verdict_rejects_a_write_that_outlived_its_disk(void) {
    psram_publish_slot(0);
    int32_t before = psram_active_token();
    psram_publish_slot(1);                  // a swap landed during the write
    int32_t after = psram_active_token();
    mfm_decode_result_t d = whole(10);
    CHECK_EQ_INT(write_back_verdict(&d, 10, false, before, after), WB_REJECT_DISK_CHANGED);

    psram_publish_slot(SLOT_NONE);          // an eject
    int32_t none = psram_active_token();
    CHECK_EQ_INT(write_back_verdict(&d, 10, false, none, none), WB_REJECT_NO_DISK);
}

static void every_verdict_has_a_reason(void) {
    for (int v = WB_APPLY; v <= WB_REJECT_DENSITY; v++) {
        CHECK(write_back_reason((wb_verdict_t)v, MFM_SECTORS)[0] != '\0', "a log line needs a reason");
        CHECK(write_back_reason((wb_verdict_t)v, MFM_HD_SECTORS)[0] != '\0', "on HD too");
    }
    CHECK(strstr(write_back_reason(WB_REJECT_PARTIAL, MFM_SECTORS), "11") != NULL, "DD names its count");
    CHECK(strstr(write_back_reason(WB_REJECT_PARTIAL, MFM_HD_SECTORS), "22") != NULL, "HD names its count");
}

// HD writes spec §4.2: the mounted disk's count decides. An HD disk wants all
// 22 sectors; a DD disk refuses any good sector numbered past 10.
static void an_hd_disk_wants_all_22_sectors(void) {
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    int32_t tok = mounted_token();
    CHECK_EQ_INT(write_back_sectors(tok), MFM_HD_SECTORS);
    CHECK_EQ_INT(write_back_mask(MFM_HD_SECTORS), 0x3fffff);
    mfm_decode_result_t d = whole(80);            /* 0x7ff: 11 of 22 */
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    d.found = 0x3fffffu;
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_APPLY);
    psram_image_reset_slot(0);     /* back to MFM, for anything that runs after */
}

static void a_dd_disk_refuses_sectors_past_10(void) {
    psram_image_reset_slot(0);
    int32_t tok = mounted_token();
    CHECK_EQ_INT(write_back_sectors(tok), MFM_SECTORS);
    mfm_decode_result_t d = whole(80);
    d.foreign_sectors = 11;                        /* ids 11..21 of an HD track */
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_DENSITY);
    CHECK_EQ_INT(write_back_verdict(&d, 80, true, tok, tok), WB_REJECT_OVERFLOW);   /* order: overflow first */
}

// Real tracks, not hand-set bitmaps: Greaseweazle's HD track on a DD disk,
// and our DD encoder's track on an HD disk (spec §7, firmware host). The
// fixture reader is hd_fixture.h's.
static void a_dd_disk_refuses_a_real_hd_track(void) {
    static uint8_t mfm[HD_MFM_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    CHECK(read_hd_fixture(80, mfm), "fixtures/adf_mfm_hd/prng-t080.mfm");
    psram_image_reset_slot(0);                     /* MFM: a DD disk */
    int32_t tok = mounted_token();
    mfm_decode_result_t d;
    mfm_decode_track_n(mfm, HD_MFM_BYTES, got, &d, write_back_sectors(tok));
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_DENSITY);
}

static void an_hd_disk_refuses_a_real_dd_track(void) {
    static uint8_t data[MFM_TRACK_DATA_BYTES], mfm[MFM_TRACK_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    memset(data, 0x42, sizeof data);
    mfm_encode_track(data, 80, mfm);
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    int32_t tok = mounted_token();
    mfm_decode_result_t d;
    mfm_decode_track_n(mfm, sizeof mfm, got, &d, write_back_sectors(tok));
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    psram_image_reset_slot(0);
}

// The four gates on WPROT, one function so the HD one is tested (main.c's
// core1 loop only feeds it).
static void wprot_is_forced_for_an_hd_disk(void) {
    CHECK(write_back_wprot(true, false, false, true), "HD mounted, server says writable: still protected");
    CHECK(!write_back_wprot(true, false, false, false), "DD, writable, nothing forcing: released");
    CHECK(write_back_wprot(false, false, false, false), "nothing mounted: protected");
    CHECK(write_back_wprot(true, true, false, false), "the server's flag");
    CHECK(write_back_wprot(true, false, true, false), "the uploader's force");
}

/* A disk in slot 0 whose track `t` holds the encoding of `data`. */
static void seed_track(int t, const uint8_t *data) {
    static uint8_t mfm[MFM_TRACK_BYTES];
    uint32_t bits = mfm_encode_track(data, (uint8_t)t, mfm);
    psram_image_write_at(0, t, 0, mfm, MFM_TRACK_BYTES);
    psram_image_commit(0, t, bits);
    psram_publish_slot(0);
}

static void decode_served(int t, uint8_t *out) {
    uint32_t bits = 0;
    const uint8_t *m = track_cache_get(t, &bits);
    memset(out, 0, MFM_TRACK_DATA_BYTES);
    if (!m) { CHECK(0, "track must be served"); return; }
    mfm_decode_result_t r;
    mfm_decode_track(m, (bits + 7u) / 8u, out, &r);
    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.track_no, t);
}

static void apply_stores_dirty_and_the_new_bytes_are_served(void) {
    static uint8_t oldt[MFM_TRACK_DATA_BYTES], newt[MFM_TRACK_DATA_BYTES], got[MFM_TRACK_DATA_BYTES];
    memset(oldt, 0x11, sizeof oldt);
    for (size_t i = 0; i < sizeof newt; i++) newt[i] = (uint8_t)(i * 7u);
    seed_track(40, oldt);

    decode_served(40, got);                 // caches the OLD copy in SRAM
    CHECK(memcmp(got, oldt, sizeof got) == 0, "before: old bytes");

    CHECK(write_back_apply(0, 40, newt), "apply must land");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);

    // Without invalidation the SRAM copy is stale -- this is WHY the
    // function exists. Asserted so that deleting it is a test failure.
    decode_served(40, got);
    CHECK(memcmp(got, oldt, sizeof got) == 0, "SRAM still holds the old copy");

    track_cache_invalidate(40);
    decode_served(40, got);
    CHECK(memcmp(got, newt, sizeof got) == 0, "after invalidate: the written bytes");
}

/* ---- the whole chain, from flux, on a capture shaped like a real one ---- */

static bool bit_at(const uint8_t *b, size_t i) { return (b[i >> 3] >> (7 - (i & 7))) & 1u; }

static void capture_shaped_write_applies_and_reads_back(void) {
    // What the Amiga writes: a standard track of NEW data. The capture starts
    // `skew` bits in (any edge after WGATE) -- 1-7 bits off byte alignment is
    // exactly what hid the byte-only sync search (2026-09-15).
    static uint8_t oldt[MFM_TRACK_DATA_BYTES], newt[MFM_TRACK_DATA_BYTES], got[MFM_TRACK_DATA_BYTES];
    static uint8_t wire[MFM_TRACK_BYTES], bitsbuf[MFM_TRACK_BYTES + 16];
    memset(oldt, 0, sizeof oldt);
    for (size_t i = 0; i < sizeof newt; i++) newt[i] = (uint8_t)(i ^ 0x5a);
    const int t = 123;
    seed_track(t, oldt);
    int32_t tok = psram_active_token();
    mfm_encode_track(newt, (uint8_t)t, wire);

    for (unsigned skew = 1; skew <= 7; skew++) {
        flux_bits_t f;
        flux_bits_init(&f, bitsbuf, sizeof bitsbuf);
        size_t prev = SIZE_MAX;
        for (size_t i = skew; i < sizeof wire * 8u; i++) {
            if (!bit_at(wire, i)) continue;
            if (prev != SIZE_MAX) flux_bits_feed(&f, (uint32_t)(i - prev) * CELL_NS);
            prev = i;
        }
        static uint8_t decoded[MFM_TRACK_DATA_BYTES];
        memset(decoded, 0, sizeof decoded);
        mfm_decode_result_t d;
        mfm_decode_track(bitsbuf, flux_bits_bytes(&f), decoded, &d);

        CHECK_EQ_INT(write_back_verdict(&d, t, f.overflowed, tok, psram_active_token()), WB_APPLY);
        CHECK(write_back_apply(0, t, decoded), "apply");
        track_cache_invalidate(t);
        decode_served(t, got);
        CHECK(memcmp(got, newt, sizeof got) == 0, "the Amiga reads back what it wrote");
    }
}

static void the_hd_store_takes_only_an_hd_slot(void) {
    static uint8_t adf[MFM_HD_TRACK_DATA_BYTES];
    memset(adf, 0x5a, sizeof adf);
    psram_image_reset_slot(0);                               /* MFM */
    CHECK(!psram_image_store_adf(0, 3, adf), "an MFM slot never takes ADF bytes");
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    CHECK(!psram_image_store_adf(0, NUM_TRACKS, adf), "a track past the disk");
    CHECK(psram_image_store_adf(0, 3, adf), "an HD slot does");
    CHECK_EQ_INT(psram_image_state(0, 3), TRK_DIRTY);
    CHECK_EQ_INT(psram_image_bits(0, 3), MFM_HD_TRACK_DATA_BYTES * 8u);
    CHECK(memcmp(psram_image_track_data(0, 3), adf, sizeof adf) == 0, "the bytes as given");
    static uint8_t mfm[MFM_TRACK_BYTES];
    psram_image_mark_dirty(0, 4, mfm, MFM_TRACK_BITS);
    CHECK_EQ_INT(psram_image_state(0, 4), TRK_ABSENT);       /* MFM never goes into an ADF slot */
    psram_image_reset_slot(0);
}

// HD writes spec §7, firmware host: Greaseweazle's encoding of an HD track
// (independent of this code), through the board's whole chain -- flux ->
// bits -> 22 sectors -> verdict -> store -> encode on read -- must give back
// the ADF bytes, and the served track must be Greaseweazle's, byte for byte.
static void an_hd_write_is_stored_and_served_back(void) {
    static uint8_t wire[HD_MFM_BYTES], want[MFM_HD_TRACK_DATA_BYTES], zeros[MFM_HD_TRACK_DATA_BYTES];
    CHECK(read_hd_fixture(80, wire), "fixtures/adf_mfm_hd/prng-t080.mfm");
    hd_prng_track(80, want);                                 /* the 'prng' disk's track 80 */

    // An HD disk in slot 0 whose track 80 holds zeros, served (and so cached)
    // before the write.
    memset(zeros, 0, sizeof zeros);
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    psram_image_write_at(0, 80, 0, zeros, (int)sizeof zeros);
    psram_image_commit(0, 80, MFM_HD_TRACK_DATA_BYTES * 8u);
    psram_publish_slot(0);
    const int32_t tok = psram_active_token();
    uint32_t bits = 0;
    CHECK(track_cache_get(80, &bits) != NULL, "the old track is served");

    static uint8_t capbuf[FLUX_CAPTURE_BUF_BYTES];
    for (unsigned skew = 1; skew <= 7; skew += 3) {
        flux_bits_t fb;
        flux_bits_init(&fb, capbuf, sizeof capbuf);
        size_t prev = SIZE_MAX;
        for (size_t i = skew; i < HD_MFM_BYTES * 8u; i++) {
            if (!bit_at(wire, i)) continue;
            if (prev != SIZE_MAX) flux_bits_feed(&fb, (uint32_t)(i - prev) * CELL_NS);
            prev = i;
        }
        static uint8_t decoded[MFM_HD_TRACK_DATA_BYTES];
        memset(decoded, 0, sizeof decoded);
        mfm_decode_result_t d;
        mfm_decode_track_n(capbuf, flux_bits_bytes(&fb), decoded, &d, write_back_sectors(tok));
        CHECK_EQ_INT(d.found, 0x3fffff);
        CHECK_EQ_INT(write_back_verdict(&d, 80, fb.overflowed, tok, psram_active_token()), WB_APPLY);
        CHECK(write_back_apply(0, 80, decoded), "an HD track is stored");
        CHECK_EQ_INT(psram_image_state(0, 80), TRK_DIRTY);
        CHECK_EQ_INT(psram_image_next_dirty(0), 80);             /* the uploader will find it */
        const uint8_t *stored = psram_image_track_data(0, 80);
        CHECK(stored != NULL && memcmp(stored, want, sizeof want) == 0,
              "PSRAM holds the ADF bytes the Amiga wrote");

        track_cache_invalidate(80);                          /* main.c does this after every apply */
        const uint8_t *served = track_cache_get(80, &bits);
        CHECK(served != NULL, "served");
        CHECK_EQ_INT(bits, ADF_MFM_HD_TRACK_BITS);
        CHECK(served != NULL && memcmp(served, wire, HD_MFM_BYTES) == 0,
              "re-encoded exactly as Greaseweazle encoded it");

        // Back to the old contents for the next skew.
        psram_image_write_at(0, 80, 0, zeros, (int)sizeof zeros);
        psram_image_clear_dirty(0, 80);
        track_cache_invalidate(80);
    }
    psram_image_reset_slot(0);
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    track_cache_init();
    RUN(verdict_applies_a_whole_clean_track);
    RUN(verdict_rejects_each_fault);
    RUN(verdict_rejects_a_write_that_outlived_its_disk);
    RUN(every_verdict_has_a_reason);
    RUN(apply_stores_dirty_and_the_new_bytes_are_served);
    RUN(capture_shaped_write_applies_and_reads_back);
    RUN(an_hd_disk_wants_all_22_sectors);
    RUN(a_dd_disk_refuses_sectors_past_10);
    RUN(a_dd_disk_refuses_a_real_hd_track);
    RUN(an_hd_disk_refuses_a_real_dd_track);
    RUN(wprot_is_forced_for_an_hd_disk);
    RUN(the_hd_store_takes_only_an_hd_slot);
    RUN(an_hd_write_is_stored_and_served_back);
    free(mem);
    return REPORT();
}
