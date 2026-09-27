#ifndef BUS_OUT_H
#define BUS_OUT_H
// ---------------------------------------------------------------------------
// The ONLY writer of the status outputs: INDEX, CHNG, WPROT, RDY, TRK0.
//
// Those pads belong to the status_gate PIO program (floppy.pio), which puts
// this word on them while SEL0 is asserted and releases them all while it is
// not. gpio_put() on them does NOTHING once PIO owns the pad -- silently -- so
// test/run.sh fails the build if one comes back.
//
// Written from the DMA IRQ (INDEX), the STEP ISR (TRK0), dskchg (CHNG/RDY) on
// core0 and the poll loop (WPROT) on core1: every update is a read-modify-write
// of one shared word, so it runs under a hardware spinlock with interrupts off.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include "hardware/pio.h"

// Hands the five status pads to `pio`, loads status_gate on a free state
// machine, and starts it with `initial` (a GPIO mask of asserted pins).
// Call once on core0, before anything else sets an output.
void bus_out_init(PIO pio, uint32_t initial);

void bus_out_set(unsigned pin, bool assert);

// CMake passes WF_DRIVE_ID=0 or 1 (option WF_DRIVE_ID, default ON). The
// fallback is the conservative one: no responder.
#ifndef WF_DRIVE_ID
#define WF_DRIVE_ID 0
#endif

#if WF_DRIVE_ID
// Hands RDY to floppy.pio's drive_id program on `pio`, which answers the
// Amiga's drive-ID read on DF0's motor-off selects (drive_id.h, HD spec
// §5.4). Answers DD until bus_out_drive_id_set_hd(true). bus_out_set(PIN_RDY,
// ...) keeps working: the level goes to drive_id. Call once on core0, after
// bus_out_init.
void bus_out_drive_id_init(PIO pio);
// Answer HD (true) or DD (false) from the next answer on -- the first
// motor-off select after a motor-on one, or the 32-bit repeat, never
// mid-answer. Core0 only. True if it
// changed.
bool bus_out_drive_id_set_hd(bool hd);
#endif

#endif
