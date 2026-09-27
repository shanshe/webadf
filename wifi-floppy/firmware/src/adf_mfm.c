#include "adf_mfm.h"
#include <string.h>

// Line-for-line with src/lib/adfmfm (track.ts encodeTrack, mfm.ts). The three
// easy mistakes that module's README lists hold here too: the odd/even split
// is PER FIELD; the header's 4th byte counts sectors to the gap by physical
// position; the checksum runs over the raw, pre-split bytes.

uint32_t adf_mfm_track_bytes(unsigned nsec) {
    if (nsec == ADF_MFM_DD_SECTORS) return ADF_MFM_DD_TRACK_BYTES;
    if (nsec == ADF_MFM_HD_SECTORS) return ADF_MFM_HD_TRACK_BYTES;
    return 0;
}

// Odd bits of every byte, then even bits: n bytes in, 2n out.
static void split_odd_even(const uint8_t *src, uint32_t n, uint8_t *dst) {
    for (uint32_t i = 0; i < n; i++) {
        dst[i]     = (uint8_t)((src[i] >> 1) & 0x55u);
        dst[n + i] = (uint8_t)(src[i] & 0x55u);
    }
}

// XOR of the big-endian longs, folded into the 0x55555555 lanes.
static uint32_t checksum(const uint8_t *src, uint32_t n) {
    uint32_t c = 0;
    for (uint32_t i = 0; i < n; i += 4)
        c ^= ((uint32_t)src[i] << 24) | ((uint32_t)src[i + 1] << 16) |
             ((uint32_t)src[i + 2] << 8) | (uint32_t)src[i + 3];
    return (c ^ (c >> 1)) & 0x55555555u;
}

static void be32(uint32_t v, uint8_t out[4]) {
    out[0] = (uint8_t)(v >> 24); out[1] = (uint8_t)(v >> 16);
    out[2] = (uint8_t)(v >> 8);  out[3] = (uint8_t)v;
}

// mfm.ts fillClockBits: a clock bit wherever neither neighbouring data bit is
// set, carried across byte boundaries by a 16-bit window.
static void fill_clock_bits(uint8_t *t, uint32_t n) {
    uint32_t y = 0;
    for (uint32_t i = 0; i < n; i++) {
        const uint32_t x = t[i];
        y = ((y << 8) | x) & 0xffffu;
        if ((x & 0xaau) == 0) y |= ~((y >> 1) | (y << 1)) & 0xaaaau;
        y &= 0xffu;
        t[i] = (uint8_t)y;
    }
}

uint32_t adf_mfm_encode_track(const uint8_t *data, unsigned nsec, unsigned track_no,
                              uint8_t *out) {
    const uint32_t total = adf_mfm_track_bytes(nsec);
    if (total == 0 || track_no >= ADF_MFM_TRACKS) return 0;

    memset(out, 0, total);                               // every gap is zero before the fill
    const uint32_t lead = 256u * (nsec / ADF_MFM_DD_SECTORS);
    uint8_t hl[20];                                      // header (4) + label (16)
    uint8_t sum[4];

    for (unsigned n = 0; n < nsec; n++) {
        const uint8_t *sd = data + n * ADF_MFM_SECTOR_BYTES;
        memset(hl, 0, sizeof hl);
        hl[0] = 0xff;
        hl[1] = (uint8_t)track_no;
        hl[2] = (uint8_t)n;
        hl[3] = (uint8_t)(nsec - n);

        uint8_t *p = out + lead + n * ADF_MFM_SECTOR_MFM_BYTES;
        p[0] = 0x44; p[1] = 0x89; p[2] = 0x44; p[3] = 0x89; p += 4;
        split_odd_even(hl, 4, p);                        p += 8;
        split_odd_even(hl + 4, 16, p);                   p += 32;
        be32(checksum(hl, 20), sum);
        split_odd_even(sum, 4, p);                       p += 8;
        be32(checksum(sd, ADF_MFM_SECTOR_BYTES), sum);
        split_odd_even(sum, 4, p);                       p += 8;
        split_odd_even(sd, ADF_MFM_SECTOR_BYTES, p);     // + 1024, then 4 zero bytes
    }
    fill_clock_bits(out, total);
    return total;
}
