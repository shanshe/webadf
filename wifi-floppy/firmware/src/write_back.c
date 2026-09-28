#include "write_back.h"
#include "psram_image.h"
#include <stdbool.h>

unsigned write_back_sectors(int32_t token) {
    return psram_image_slot_kind(psram_token_slot(token)) == SLOT_KIND_ADF_HD
        ? MFM_HD_SECTORS : MFM_SECTORS;
}

uint32_t write_back_mask(unsigned nsec) {
    return nsec >= 32u ? 0xffffffffu : (1u << nsec) - 1u;
}

wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now) {
    // Disk identity first: a write belongs to the disk that was mounted when
    // WGATE asserted, and to no other -- however good its sectors are.
    if (psram_token_slot(token_now) == SLOT_NONE) return WB_REJECT_NO_DISK;
    if (token_now != token_at_wgate)              return WB_REJECT_DISK_CHANGED;
    if (overflowed)                               return WB_REJECT_OVERFLOW;
    // HD writes spec §4.2: the mounted disk's count decides, never the data's.
    // A DD disk given an HD track decodes sectors 0..10 cleanly -- complete by
    // the mask alone -- so its good sectors 11..21 are what give it away.
    if (d->foreign_sectors)                       return WB_REJECT_DENSITY;
    if (d->found != write_back_mask(write_back_sectors(token_now)))
                                                  return WB_REJECT_PARTIAL;
    if (!d->track_no_consistent)                  return WB_REJECT_INCONSISTENT;
    // The one corruption a checksum cannot see: a valid track for a cylinder
    // the head is not on.
    if ((int)d->track_no != head_track)           return WB_REJECT_WRONG_TRACK;
    return WB_APPLY;
}

const char *write_back_reason(wb_verdict_t v, unsigned nsec) {
    const bool hd = nsec == MFM_HD_SECTORS;
    switch (v) {
    case WB_APPLY:               return "applied";
    case WB_REJECT_NO_DISK:      return "no disk mounted";
    case WB_REJECT_DISK_CHANGED: return "disk changed during the write";
    case WB_REJECT_OVERFLOW:     return "capture overflowed";
    case WB_REJECT_PARTIAL:      return hd ? "not all 22 sectors verified" : "not all 11 sectors verified";
    case WB_REJECT_INCONSISTENT: return "sector headers disagree about the track";
    case WB_REJECT_WRONG_TRACK:  return "sectors name another track";
    case WB_REJECT_DENSITY:      return hd ? "sectors numbered 22 or more"
                                           : "sectors numbered 11 or more: an HD track on a DD disk";
    }
    return "unknown";
}

bool write_back_apply(int slot, int track, const uint8_t *adf_track) {
    // HD writes spec §4.3: an HD slot holds ADF bytes and is encoded on read
    // (track_cache.c), so the verified sectors go in as they are. main.c's
    // track_cache_invalidate() after this makes the next read re-encode them.
    if (psram_image_slot_kind(slot) == SLOT_KIND_ADF_HD)
        return psram_image_store_adf(slot, track, adf_track);

    // Static: 12.6 KB would not fit core0's frame. Not re-entrant, and only
    // ever called from core0's service loop.
    static uint8_t mfm[MFM_TRACK_BYTES];
    const uint32_t bits = mfm_encode_track(adf_track, (uint8_t)track, mfm);
    psram_image_mark_dirty(slot, track, mfm, bits);
    return psram_image_state(slot, track) == TRK_DIRTY;
}

bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced) {
    return !mounted || server_protected || uploader_forced;
}
