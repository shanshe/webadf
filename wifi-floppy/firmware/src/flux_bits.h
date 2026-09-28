#ifndef FLUX_BITS_H
#define FLUX_BITS_H
// Flux intervals -> an MFM bitstream.
//
// The PIO (flux_in, src/floppy.pio) reports the gap between one WDATA edge and
// the next. That is what the wire carries: a transition is a 1 bit and the
// cells between transitions are 0s, so an interval of k bitcells is a 1
// followed by k-1 zeros. Reassembling those into bytes is what turns a write
// into something mfm_decode_track() can read.
//
// Pure C, no pico-sdk -- the rule device_client.h states. It is also the only
// part of the capture path that CAN be tested without an Amiga: the device
// half is a PIO state machine and a DMA channel, which only a floppy bus can
// exercise. So everything that is a decision rather than a register write
// lives here.
//
// WHY NOT BUFFER THE RAW INTERVALS. A written track is ~200 ms of flux with a
// transition every 4-8 us: 25,000-50,000 of them, and one 32-bit word each is
// 100-200 KB. Converting to bits as they arrive costs 12,668 bytes instead --
// the same size as the track it represents, because that is exactly what it
// is.
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/**
 * The capture's window and buffer (HD writes spec §4.1). Here rather than in
 * flux_capture.h so the host tests can hold the accumulator to them:
 * flux_capture.h is device-only (it includes hardware/pio.h).
 *
 * 800 ms: two HD revolutions (an Amiga HD drive spins at 150 rpm, 400 ms a
 * turn, with the same 2 us cell as DD). A write is one revolution plus its
 * lead gap; a WGATE held longer than this is not a write.
 *
 * 32,768 bytes: one HD write, lead gap included, with DD's margin. A DD write
 * measured 108,992 bits (13,624 bytes) against DD's 16,384-byte buffer; an HD
 * write at twice that is ~27,250. The spec's 28,672 would leave 5 %; this
 * leaves DD's 20 % for 4 KB more. This file's own "fits the capture" test
 * only exercises ~28,652 of it (an HD write behind a doubled DD lead gap,
 * §4.1's fixture) -- that does not justify 32 KB on its own; the rest is
 * margin for the HD lead gap, which is not measured yet. Bench step 3
 * records the real size (the `write: trk N ... B` log line).
 */
#define FLUX_CAPTURE_MAX_MS     800u
#define FLUX_CAPTURE_BUF_BYTES  32768u

/**
 * Below this many ns, no legal MFM cell fits (2 cells at the standard
 * 2,000 ns/cell is 4,000 ns): the line glitched, not the disk. Seen on the
 * bench 2026-09-27 (HD writes, HANDOFF 3ao step 3): one capture of 28 had a
 * 1,640 ns interval among flux that otherwise never went below ~3,600 ns, and
 * decoded to nothing. flux_capture.c's diagnostics count intervals against
 * this threshold via flux_ns_is_glitch() below, and this file's tests use the
 * same function, so the two cannot drift apart. See
 * flux_capture_result_t.glitches.
 */
#define FLUX_GLITCH_NS 3000u

/** True if an interval this short cannot be legal MFM flux. */
static inline bool flux_ns_is_glitch(uint32_t ns) { return ns < FLUX_GLITCH_NS; }

typedef struct {
    uint8_t *buf;
    size_t   cap_bits;
    size_t   bit;          /* next bit index to write */
    /** Set the moment a bit is dropped for want of room, and never cleared by
     *  the accumulator itself. A capture that silently stopped early would
     *  decode to a track missing its last sectors, which is indistinguishable
     *  from a damaged disk unless this says otherwise. */
    bool     overflowed;
    uint32_t intervals;
    /** Intervals longer than any legal MFM gap. A healthy stream has none;
     *  a few mean noise or a capture that began before WGATE settled, and a
     *  great many mean this is not an MFM stream at all. */
    uint32_t out_of_range;
} flux_bits_t;

/** `cap` is the buffer size in BYTES; it is cleared. */
void flux_bits_init(flux_bits_t *f, uint8_t *buf, size_t cap);

/** One flux interval, in nanoseconds. */
void flux_bits_feed(flux_bits_t *f, uint32_t ns);

/** Bytes written so far, rounded up to include a partial final byte. */
size_t flux_bits_bytes(const flux_bits_t *f);

/**
 * Convert a raw PIO down-counter reading into nanoseconds.
 *
 * flux_in spends 2 PIO cycles per loop iteration and counts DOWN from zero, so
 * the pushed value is the two's-complement of the iteration count. Kept here,
 * beside the only code that consumes it, because the relationship between a
 * counter tick and a nanosecond is exactly the kind of fact that goes stale
 * silently when the clock divider changes.
 */
uint32_t flux_counter_to_ns(uint32_t counter, uint32_t pio_clk_hz);

#endif
