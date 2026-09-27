// The C ADF->MFM encoder (src/adf_mfm.c) against three oracles (HD spec §5.2).
//   1. DD, synthetic disks: the committed Greaseweazle fixtures that
//      src/lib/adfmfm's own suite is held to (byte-identical there too).
//   2. HD, synthetic disks: Greaseweazle AmigaDOS_HD fixtures
//      (scripts/adf-mfm-hd-fixtures.py -> test/fixtures/adf_mfm_hd).
//   3. DD, real disks: the TS encoder's output, all 160 tracks, when
//      scripts/adf-mfm-real-fixtures.ts has written test/.build/adf_mfm_real.
//      Never committed (derived from real disks); skipped, and said so, if absent.
#include "harness.h"
#include "../src/adf_mfm.h"
#include "../src/sha256.h"
#include <stdint.h>
#include <stdlib.h>

#define DD_BYTES (ADF_MFM_DD_SECTORS * 512u * 160u)
#define HD_BYTES (ADF_MFM_HD_SECTORS * 512u * 160u)

// src/lib/adfmfm/synthetic.ts's xorshift32 fill.
static void fill(uint8_t *out, uint32_t from, uint32_t len, uint32_t seed) {
    uint32_t x = seed;
    for (uint32_t i = from; i < len; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        out[i] = (uint8_t)x;
    }
}

// synthetic.ts's kinds; `root` is the root block written at byte 8 (880 DD, 1760 HD).
static void synthetic(const char *kind, uint8_t *out, uint32_t len, uint32_t root) {
    memset(out, 0, len);
    if (!strcmp(kind, "ones")) memset(out, 0xff, len);
    else if (!strcmp(kind, "prng")) fill(out, 0, len, 0x12345678u);
    else if (!strcmp(kind, "bootblock")) {
        out[0] = 'D'; out[1] = 'O'; out[2] = 'S'; out[3] = 0;
        out[8] = (uint8_t)(root >> 24); out[9] = (uint8_t)(root >> 16);
        out[10] = (uint8_t)(root >> 8); out[11] = (uint8_t)root;
        fill(out, 12, len, 0xdeadbeefu);
    }
}

static uint8_t *read_file(const char *path, long *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    *len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc((size_t)*len);
    if (fread(b, 1, (size_t)*len, f) != (size_t)*len) { free(b); b = NULL; }
    fclose(f);
    return b;
}

static int first_diff(const uint8_t *a, const uint8_t *b, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) if (a[i] != b[i]) return (int)i;
    return -1;
}

static void check_fixtures(const char *dir, const char *const *kinds, unsigned nkinds,
                           unsigned nsec, uint32_t adf_len, uint32_t root) {
    static const unsigned tracks[] = {0, 1, 80, 159};
    const uint32_t tb = adf_mfm_track_bytes(nsec);
    uint8_t *adf = malloc(adf_len), *out = malloc(tb);
    for (unsigned k = 0; k < nkinds; k++) {
        synthetic(kinds[k], adf, adf_len, root);
        for (unsigned i = 0; i < 4; i++) {
            char path[256];
            snprintf(path, sizeof path, "%s/%s-t%03u.mfm", dir, kinds[k], tracks[i]);
            long len = 0;
            uint8_t *want = read_file(path, &len);
            CHECK(want != NULL, path);
            if (!want) continue;
            CHECK_EQ_INT(len, tb);
            CHECK_EQ_INT(adf_mfm_encode_track(adf + tracks[i] * nsec * 512u, nsec, tracks[i], out), tb);
            const int d = first_diff(out, want, tb);
            if (d >= 0) printf("  %s differs first at byte %d\n", path, d);
            CHECK(d < 0, "byte-identical to Greaseweazle");
            free(want);
        }
    }
    free(adf); free(out);
}

static void dd_matches_greaseweazle(void) {
    static const char *const kinds[] = {"zeros", "ones", "prng", "bootblock"};
    check_fixtures("../../../src/lib/adfmfm/fixtures", kinds, 4, ADF_MFM_DD_SECTORS, DD_BYTES, 880);
}

static void hd_matches_greaseweazle(void) {
    static const char *const kinds[] = {"prng", "bootblock"};
    check_fixtures("fixtures/adf_mfm_hd", kinds, 2, ADF_MFM_HD_SECTORS, HD_BYTES, 1760);
}

static void rejects_bad_geometry(void) {
    static uint8_t data[ADF_MFM_HD_SECTORS * 512], out[ADF_MFM_HD_TRACK_BYTES];
    CHECK_EQ_INT(adf_mfm_track_bytes(11), 12668);
    CHECK_EQ_INT(adf_mfm_track_bytes(22), 25336);
    CHECK_EQ_INT(adf_mfm_track_bytes(18), 0);
    CHECK_EQ_INT(adf_mfm_encode_track(data, 12, 0, out), 0);
    CHECK_EQ_INT(adf_mfm_encode_track(data, 11, 160, out), 0);
}

// The HD layout, spelled out: 512-byte lead gap, 22 sectors, 888-byte trail,
// header byte 4 counting down 22..1 -- independent of Greaseweazle's code.
static void hd_layout(void) {
    static uint8_t data[ADF_MFM_HD_SECTORS * 512], out[ADF_MFM_HD_TRACK_BYTES];
    fill(data, 0, sizeof data, 1);
    adf_mfm_encode_track(data, 22, 7, out);
    int syncs = 0;
    for (uint32_t i = 0; i + 1 < sizeof out; i++)
        if (out[i] == 0x44 && out[i + 1] == 0x89 && i + 3 < sizeof out &&
            out[i + 2] == 0x44 && out[i + 3] == 0x89) { syncs++; i += 3; }
    CHECK_EQ_INT(syncs, 22);
    CHECK(out[512] == 0x44 && out[513] == 0x89, "first sync right after the 512-byte lead gap");
    CHECK(out[511] == 0xaa, "lead gap is MFM zeros");
    // Last sector ends at 512 + 22*1088 = 24448; 888 bytes of trail follow.
    CHECK_EQ_INT(sizeof out - (512 + 22 * 1088), 888);
    // Sector 21's header: odd/even of ff 07 15 01 -> the 4th byte counts 1.
    const uint8_t *h = out + 512 + 21 * 1088 + 4;
    const uint8_t b3 = (uint8_t)(((h[3] << 1) & 0xaa) | (h[7] & 0x55));
    const uint8_t b2 = (uint8_t)(((h[2] << 1) & 0xaa) | (h[6] & 0x55));
    CHECK_EQ_INT(b2, 21);
    CHECK_EQ_INT(b3, 1);
}

static void dd_real_disks_match_ts(void) {
    FILE *m = fopen(".build/adf_mfm_real/manifest.txt", "r");
    if (!m) {
        printf("  SKIPPED: no .build/adf_mfm_real/manifest.txt -- run "
               "scripts/adf-mfm-real-fixtures.ts (needs adf-archive/)\n");
        return;
    }
    char line[2048];
    static uint8_t out[ADF_MFM_DD_TRACK_BYTES];
    unsigned disks = 0;
    while (fgets(line, sizeof line, m)) {
        char *tab = strchr(line, '\t');
        if (!tab) continue;
        *tab = 0;
        char *mfm_path = tab + 1;
        mfm_path[strcspn(mfm_path, "\r\n")] = 0;
        long alen = 0, mlen = 0;
        uint8_t *adf = read_file(line, &alen), *want = read_file(mfm_path, &mlen);
        CHECK(adf && want, line);
        if (adf && want) {
            CHECK_EQ_INT(alen, DD_BYTES);
            CHECK_EQ_INT(mlen, 160 * ADF_MFM_DD_TRACK_BYTES);
            unsigned bad = 0;
            for (unsigned t = 0; t < 160; t++) {
                adf_mfm_encode_track(adf + t * 5632u, 11, t, out);
                if (memcmp(out, want + t * ADF_MFM_DD_TRACK_BYTES, sizeof out)) bad++;
            }
            if (bad) printf("  %s: %u of 160 tracks differ\n", line, bad);
            CHECK_EQ_INT(bad, 0);
            disks++;
        }
        free(adf); free(want);
    }
    fclose(m);
    printf("  %u real disk(s), 160 tracks each, byte-identical to the TS encoder\n", disks);
}

// All 160 tracks, not four: every track of the synthetic 'prng' disk against
// Greaseweazle's own digest of it (prng-digests.txt, written by
// scripts/adf-mfm-hd-fixtures.py). The track number and side go into every
// sector header, so a mistake that shows on only some tracks cannot hide
// behind the four full fixtures above.
static void hd_all_tracks_match_greaseweazle_digests(void) {
    FILE *f = fopen("fixtures/adf_mfm_hd/prng-digests.txt", "r");
    CHECK(f != NULL, "fixtures/adf_mfm_hd/prng-digests.txt (scripts/adf-mfm-hd-fixtures.py)");
    if (!f) return;
    uint8_t *adf = malloc(HD_BYTES);
    static uint8_t out[ADF_MFM_HD_TRACK_BYTES];
    synthetic("prng", adf, HD_BYTES, 1760);
    unsigned seen = 0, bad = 0, tno;
    char want[65];
    while (fscanf(f, "%u %64s", &tno, want) == 2) {
        CHECK(tno < ADF_MFM_TRACKS, "track number in range");
        if (tno >= ADF_MFM_TRACKS) break;
        CHECK_EQ_INT(adf_mfm_encode_track(adf + tno * ADF_MFM_HD_SECTORS * 512u,
                                          ADF_MFM_HD_SECTORS, tno, out), ADF_MFM_HD_TRACK_BYTES);
        sha256_t s;
        uint8_t d[32];
        char got[65];
        sha256_init(&s);
        sha256_update(&s, out, sizeof out);
        sha256_final(&s, d);
        sha256_hex(d, got);
        if (strcmp(got, want) != 0) {
            if (!bad) printf("  track %u differs from Greaseweazle (first of any)\n", tno);
            bad++;
        }
        seen++;
    }
    fclose(f);
    free(adf);
    CHECK_EQ_INT(seen, ADF_MFM_TRACKS);
    CHECK_EQ_INT(bad, 0);
}

static void hd_track_bits_is_the_encoded_length(void) {
    CHECK_EQ_INT(ADF_MFM_HD_TRACK_BITS, ADF_MFM_HD_TRACK_BYTES * 8u);
    CHECK_EQ_INT(ADF_MFM_HD_TRACK_BITS % 32u, 0);   // main.c's DMA re-triggers on whole words
}

int main(void) {
    RUN(dd_matches_greaseweazle);
    RUN(hd_matches_greaseweazle);
    RUN(rejects_bad_geometry);
    RUN(hd_layout);
    RUN(dd_real_disks_match_ts);
    RUN(hd_all_tracks_match_greaseweazle_digests);
    RUN(hd_track_bits_is_the_encoded_length);
    return REPORT();
}
