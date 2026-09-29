#ifndef SWAP_GATE_H
#define SWAP_GATE_H
// ---------------------------------------------------------------------------
// "Has the Amiga finished with the disk?" -- asked before a mounted disk is
// released (a swap, a Next tap, an eject; dc_set_hold's fn in main.c).
//
// The uploader's hold (up_holds) covers only writes the board has already
// captured. AmigaDOS writes a file's data first and its header and directory
// blocks a moment later, from buffers it still holds; a swap in that gap loses
// them. On 2026-09-29 a Next tap during a save swapped Locale out after the
// data upload closed and before the file header was written: the directory's
// hash slot pointed at block 597, which never arrived, and the disk reported
// a checksum error.
//
// So the disk is released only while the Amiga is idle: motor off (the drive
// light; AmigaDOS switches it off once its buffers are written), WGATE clear,
// and no write activity -- applied or merely attempted, the later of
// g_write_last_ms and g_wgate_last_ms -- for SWAP_IDLE_MS. The same test a
// real floppy's user makes before ejecting, and the same inputs as
// reinsert_may_announce.
//
// Starvation: a powered-off Amiga leaves WGATE reading asserted and the motor
// latch where it was, forever. Measured from the last write-path activity, not
// from the request: a copy keeps writing and so is never forced, while silence
// for SWAP_FORCE_MS means nobody is writing, and the disk is released
// regardless (`*forced_out`).
//
// Pure, host-tested; wraparound handled as ((int32_t)(now - x) >= 0).
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

#define SWAP_IDLE_MS  3000u
#define SWAP_FORCE_MS 20000u

bool swap_gate_idle(uint32_t now, bool motor_on, bool wgate_asserted,
                    uint32_t last_activity_ms, bool *forced_out);
#endif
