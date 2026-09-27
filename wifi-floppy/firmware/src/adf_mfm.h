#ifndef ADF_MFM_H
#define ADF_MFM_H
// ---------------------------------------------------------------------------
// ADF track -> Amiga MFM, on the board (HD spec 2026-09-26 §5.2).
//
// A C port of src/lib/adfmfm/track.ts + mfm.ts (encodeTrack), which is
// byte-identical to Greaseweazle's amiga.amigados codec for DD. Pure C, no
// SDK: host-tested in test/test_adf_mfm.c against
//   * the committed Greaseweazle DD fixtures in src/lib/adfmfm/fixtures,
//   * Greaseweazle HD fixtures (AmigaDOS_HD) in test/fixtures/adf_mfm_hd,
//     four whole tracks plus a digest of all 160,
//   * the TS encoder's output for real disks (scripts/adf-mfm-real-fixtures.ts),
//     when that script has been run.
// track_cache.c calls it for every track of an HD disk (an ADF_HD slot);
// measured on the RP2350 at the spike: median 3.7 ms a track from SRAM,
// 4.1 ms reading the ADF from PSRAM, worst seen 4.9 ms.
//
// Layout, from Greaseweazle's AmigaDOS.master_track():
//   lead gap  128 * (nsec/11) raw zero bytes, odd/even encoded -> 256 (DD) / 512 (HD)
//   nsec sectors of 1,088 MFM bytes, sector n at position n with id n
//   trail gap zeros up to (int(0.2 s / clock) + 31) & ~31 bits, where clock is
//             14/7093790 s (DD) or half that (HD) -> 101,344 / 202,688 bits.
// HD is the same 2 us-class cell at 150 rpm as DD at 300: GW models it as a
// half cell at 0.2 s per rev, which is the same bit count. The board streams
// every track at one 2 us cell, so an HD revolution simply lasts 400 ms.
// ---------------------------------------------------------------------------
#include <stdint.h>

#define ADF_MFM_SECTOR_BYTES     512u
#define ADF_MFM_SECTOR_MFM_BYTES 1088u
#define ADF_MFM_TRACKS           160u

#define ADF_MFM_DD_SECTORS       11u
#define ADF_MFM_HD_SECTORS       22u
#define ADF_MFM_DD_TRACK_BYTES   12668u   // 101,344 bits
#define ADF_MFM_HD_TRACK_BYTES   25336u   // 202,688 bits
#define ADF_MFM_HD_TRACK_BITS    202688u  // what track_cache_get reports for an HD track

// MFM bytes of one track for `nsec` (11 or 22) sectors; 0 for anything else.
uint32_t adf_mfm_track_bytes(unsigned nsec);

// Encode one track: `data` is nsec*512 raw bytes, `out` receives
// adf_mfm_track_bytes(nsec) bytes. track_no is cyl*2 + side (0..159).
// Returns the byte count written, or 0 if nsec/track_no are out of range.
uint32_t adf_mfm_encode_track(const uint8_t *data, unsigned nsec, unsigned track_no,
                              uint8_t *out);

#endif
