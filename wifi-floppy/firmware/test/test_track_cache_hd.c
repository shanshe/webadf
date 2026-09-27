#include "harness.h"
#include "../src/track_cache.h"
#include "../src/psram_image.h"
#include "../src/image_loader.h"
#include "../src/adf_mfm.h"
#include "../src/sha256.h"
#include <stdlib.h>
#include <string.h>

// HD spec §7, firmware: WFAD -> image_loader -> track_cache_get, all 160
// tracks, held to GREASEWEAZLE's encoding of the same disk
// (fixtures/adf_mfm_hd/prng-digests.txt, scripts/adf-mfm-hd-fixtures.py) --
// never to adf_mfm.c's own output, which would only prove the code agrees
// with itself. Plus the stale-track guarantee for ADF_HD slots.

#define HD_ADF_BYTES (WFAD_TRACKS * WFAD_TRACK_BYTES)
static uint8_t *wfad;    // 16 + HD_ADF_BYTES

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// synthetic.ts's xorshift32 over the whole disk: with seed 0x12345678 this is
// exactly the 'prng' disk the fixture script feeds Greaseweazle.
static void build_wfad(uint32_t seed) {
    put_u32(wfad, WFAD_MAGIC); put_u32(wfad + 4, WFAD_VERSION);
    put_u32(wfad + 8, WFAD_TRACKS); put_u32(wfad + 12, WFAD_SECTORS);
    uint32_t x = seed;
    for (uint32_t i = 0; i < HD_ADF_BYTES; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        wfad[16 + i] = (uint8_t)x;
    }
}

static void digest(const uint8_t *p, uint32_t n, char hex[65]) {
    sha256_t s;
    uint8_t d[32];
    sha256_init(&s);
    sha256_update(&s, p, n);
    sha256_final(&s, d);
    sha256_hex(d, hex);
}

static void buffers_hold_an_encoded_hd_track(void) {
    CHECK_EQ_INT(track_cache_buf_bytes(), TRACK_BUF_BYTES);
    CHECK(TRACK_BUF_BYTES >= ADF_MFM_HD_TRACK_BYTES, "an encoded HD track fits the SRAM buffer");
    CHECK(TRACK_BUF_BYTES >= TRACK_MAX_BYTES, "and so does any PSRAM track");
}

static void every_track_matches_greaseweazle(void) {
    FILE *f = fopen("fixtures/adf_mfm_hd/prng-digests.txt", "r");
    CHECK(f != NULL, "fixtures/adf_mfm_hd/prng-digests.txt (scripts/adf-mfm-hd-fixtures.py)");
    if (!f) return;
    static char want[NUM_TRACKS][65];
    unsigned tno, n = 0;
    char hex[65];
    while (n < NUM_TRACKS && fscanf(f, "%u %64s", &tno, hex) == 2) {
        if (tno < NUM_TRACKS) { memcpy(want[tno], hex, sizeof hex); n++; }
    }
    fclose(f);
    CHECK_EQ_INT(n, NUM_TRACKS);

    track_cache_init();
    build_wfad(0x12345678u);
    const int slot = psram_inactive_slot();
    CHECK(image_parse_buffer(slot, wfad, 16 + HD_ADF_BYTES), "the WFAD loads");
    psram_publish_slot(slot);

    // First as a seeking head asks -- out of order, with repeats, so answers
    // land in both halves of the double buffer -- then every track in order.
    static const int seek[] = { 0, 159, 1, 80, 80, 2, 158, 0, 5, 4, 5 };
    const int nseek = (int)(sizeof seek / sizeof seek[0]);
    unsigned bad = 0;
    for (int i = 0; i < nseek + NUM_TRACKS; i++) {
        const int t = i < nseek ? seek[i] : i - nseek;
        uint32_t bits = 0;
        const uint8_t *mfm = track_cache_get(t, &bits);
        CHECK(mfm != NULL, "an HD track is served");
        if (!mfm) { bad++; continue; }
        CHECK_EQ_INT(bits, ADF_MFM_HD_TRACK_BITS);
        char got[65];
        digest(mfm, ADF_MFM_HD_TRACK_BYTES, got);
        if (strcmp(got, want[t]) != 0) {
            if (!bad) printf("  track %d (request %d) differs from Greaseweazle\n", t, i);
            bad++;
        }
    }
    CHECK_EQ_INT(bad, 0);
}

static void an_hd_disk_never_serves_another_disks_track(void) {
    static uint8_t want[ADF_MFM_HD_TRACK_BYTES];
    uint32_t bits = 0;
    track_cache_init();

    // Disk A (HD) in slot 0: cache its track 5.
    build_wfad(0x11111111u);
    CHECK(image_parse_buffer(0, wfad, 16 + HD_ADF_BYTES), "disk A loads");
    psram_publish_slot(0);
    CHECK(track_cache_get(5, &bits) != NULL, "A's track 5");

    // Eject, then disk B (HD, other bytes) into the same slot 0.
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_inactive_slot(), 0);
    build_wfad(0x22222222u);
    CHECK(image_parse_buffer(0, wfad, 16 + HD_ADF_BYTES), "disk B loads");
    psram_publish_slot(0);
    const uint8_t *got = track_cache_get(5, &bits);
    adf_mfm_encode_track(wfad + 16 + 5u * WFAD_TRACK_BYTES, ADF_MFM_HD_SECTORS, 5, want);
    CHECK(got && memcmp(got, want, sizeof want) == 0, "B's track 5, never A's cached encode");

    // Then a DD (MFM) disk in slot 1: served as stored, not encoded.
    psram_image_reset_slot(1);
    static uint8_t dd[64];
    memset(dd, 0x5a, sizeof dd);
    for (int t = 0; t < NUM_TRACKS; t++) {
        psram_image_write_at(1, t, 0, dd, (int)sizeof dd);
        psram_image_commit(1, t, (uint32_t)sizeof dd * 8u);
    }
    psram_publish_slot(1);
    got = track_cache_get(5, &bits);
    CHECK(got && memcmp(got, dd, sizeof dd) == 0, "a DD slot after an HD one streams as stored");
    CHECK_EQ_INT(bits, sizeof dd * 8u);
}

int main(void) {
    size_t len = (size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES;
    psram_image_set_backing(malloc(len), len);
    wfad = malloc(16 + HD_ADF_BYTES);
    RUN(buffers_hold_an_encoded_hd_track);
    RUN(every_track_matches_greaseweazle);
    RUN(an_hd_disk_never_serves_another_disks_track);
    free(wfad);
    return REPORT();
}
