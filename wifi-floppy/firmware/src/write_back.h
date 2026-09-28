#ifndef WRITE_BACK_H
#define WRITE_BACK_H
// ---------------------------------------------------------------------------
// Applying a captured write to the board's copy of the disk -- write-back
// spec §2, piece 1. Pure and host-tested: the verdict is every decision about
// whether a capture may touch the disk, and the apply is encode + store.
//
// D5: only a whole, clean track is applied. Anything else is rejected, and the
// stored copy keeps its previous contents -- AmigaDOS reads the old data back,
// which is safer than serving damage.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>
#include "mfm.h"

typedef enum {
    WB_APPLY = 0,
    WB_REJECT_NO_DISK,          // nothing mounted now
    WB_REJECT_DISK_CHANGED,     // a swap/eject landed between WGATE and now
    WB_REJECT_OVERFLOW,         // the capture ran out of room: its end is missing
    WB_REJECT_PARTIAL,          // fewer than all the disk's 11 or 22 sectors verified
    WB_REJECT_INCONSISTENT,     // sector headers disagree about the track
    WB_REJECT_WRONG_TRACK,      // a valid track, for a cylinder the head is not on
    WB_REJECT_DENSITY,          // good sectors numbered past the disk's count: the other density's track
} wb_verdict_t;

// `head_track` is the track (cyl*2+side) sampled when WGATE asserted;
// `token_at_wgate` / `token_now` are psram_active_token() then and now.
wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now);

// The mounted disk's sectors a track: 22 for an ADF_HD slot, 11 otherwise
// (HD writes spec §4.2). What main.c decodes a capture with, and what the
// verdict counts against -- both from the same token, so they cannot differ.
unsigned write_back_sectors(int32_t token);

// All `nsec` sectors found: 0x7ff DD, 0x3fffff HD.
uint32_t write_back_mask(unsigned nsec);

// Short, log-line sized. `nsec` names the count (spec §4.2).
const char *write_back_reason(wb_verdict_t v, unsigned nsec);

// Store a verified track in `slot` as DIRTY. DD (an MFM slot): encode
// `adf_track` (MFM_TRACK_DATA_BYTES) as a standard track. HD (an ADF_HD slot,
// HD writes spec §4.3): store its MFM_HD_TRACK_DATA_BYTES as they are; they
// are encoded on read. True if it landed.
bool write_back_apply(int slot, int track, const uint8_t *adf_track);

// Whether WPROT is asserted: nothing mounted, the server's flag, the
// uploader's force (up_forces_wprot), or a read-only image -- an HD disk,
// read-only in this release whatever the server sent (HD spec §5.3). Pure;
// main.c's core1 loop feeds it and drives the pin.
bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced,
                      bool read_only_image);

#endif
