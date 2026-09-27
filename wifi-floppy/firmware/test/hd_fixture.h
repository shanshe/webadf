#ifndef HD_FIXTURE_H
#define HD_FIXTURE_H
/*
 * The HD fixtures every HD firmware test reads (HD writes spec §4.2, §7): the
 * committed Greaseweazle AmigaDOS_HD tracks under fixtures/adf_mfm_hd, and the
 * generator for the bytes they encode. One copy, shared -- the decoder, the
 * verdict, the capture and the uploader tests all judge against the same
 * disk, and a second copy of the generator could drift from the first.
 *
 * Paths are relative: run.sh runs every test binary from this directory.
 * `static inline` so a test that uses only one of these still builds under
 * -Wall -Werror.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include "../src/mfm.h"

/* One Greaseweazle HD track file: prng-tNNN.mfm, bootblock-tNNN.mfm. */
#define HD_MFM_BYTES 25336u

/* scripts/adf-mfm-hd-fixtures.py's 'prng' disk: xorshift32 from 0x12345678
 * over all 1,802,240 bytes. Track `t` is bytes t*11264 .. (t+1)*11264. */
static inline void hd_prng_track(unsigned t, uint8_t *out) {
    uint32_t x = 0x12345678u;
    const size_t from = (size_t)t * MFM_HD_TRACK_DATA_BYTES;
    for (size_t i = 0; i < from + MFM_HD_TRACK_DATA_BYTES; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        if (i >= from) out[i - from] = (uint8_t)x;
    }
}

/* The 'prng' disk's track `track_no` as Greaseweazle encoded it: HD_MFM_BYTES
 * into `out`. Committed for tracks 0, 1, 80 and 159 only. */
static inline bool read_hd_fixture(int track_no, uint8_t *out) {
    char path[128];
    snprintf(path, sizeof path, "fixtures/adf_mfm_hd/prng-t%03d.mfm", track_no);
    FILE *f = fopen(path, "rb");
    if (!f) return false;
    const size_t n = fread(out, 1, HD_MFM_BYTES, f);
    fclose(f);
    return n == HD_MFM_BYTES;
}

#endif
