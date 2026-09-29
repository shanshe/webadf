#include "harness.h"
#include "../src/swap_gate.h"

/*
 * A disk may be taken away from the Amiga (swap, eject) only once it has
 * finished with it. AmigaDOS writes a file's data first and its header and
 * directory blocks a moment later, from memory; a swap in between left
 * Locale's directory pointing at a header that never arrived (block 597,
 * 2026-09-29). The drive light -- the motor -- going out is the Amiga saying
 * it is done, the same rule a real floppy's user follows.
 */

static void motor_off_and_quiet_releases(void) {
    bool forced = true;
    CHECK(swap_gate_idle(10000, false, false, 5000, &forced), "motor off, WGATE clear, 5 s quiet: release");
    CHECK(!forced, "and not as the deadline case");
}

static void motor_on_holds(void) {
    CHECK(!swap_gate_idle(10000, true, false, 5000, NULL), "the drive light is on: hold");
}

static void wgate_asserted_holds(void) {
    CHECK(!swap_gate_idle(10000, false, true, 9000, NULL), "a write in progress: hold");
}

static void within_the_quiet_window_holds(void) {
    CHECK(!swap_gate_idle(10000, false, false, 10000 - SWAP_IDLE_MS + 1, NULL),
          "a write just under SWAP_IDLE_MS ago: hold");
    CHECK(swap_gate_idle(10000, false, false, 10000 - SWAP_IDLE_MS, NULL),
          "exactly SWAP_IDLE_MS ago: release");
}

// A powered-off Amiga leaves WGATE reading asserted and the motor latch where
// it was, forever. No write-path edge at all for SWAP_FORCE_MS means nobody is
// writing: release, or a Next tap would never be answered.
static void no_write_activity_past_the_deadline_releases_forced(void) {
    bool forced = false;
    CHECK(swap_gate_idle(100000, true, true, 100000 - SWAP_FORCE_MS, &forced),
          "motor and WGATE stuck, silent for SWAP_FORCE_MS: release");
    CHECK(forced, "as the deadline case");
    CHECK(!swap_gate_idle(100000, true, true, 100000 - SWAP_FORCE_MS + 1, NULL),
          "just under the deadline: still hold");
}

// A long copy keeps writing, so its activity stays fresh and the deadline
// never fires while it runs.
static void a_busy_copy_is_never_forced(void) {
    for (uint32_t t = 0; t < 120000; t += 1000) {
        CHECK(!swap_gate_idle(t + 500, true, false, t, NULL), "writing every second: hold throughout");
    }
}

// Review I1: measured from the write path alone, the deadline would pass the
// moment a fresh save starts -- AmigaDOS reads root, directory and bitmap
// with the motor on before its first write. The motor coming on counts as
// activity; a trackloader's motor, on for minutes, does not keep counting.
static void a_motor_just_switched_on_counts_as_activity(void) {
    CHECK_EQ_INT(swap_gate_last_activity(1000, 500, true, 60000), 60000);
    CHECK(!swap_gate_idle(62000, true, false, swap_gate_last_activity(1000, 500, true, 60000), NULL),
          "a save starting 60 s after the last write: hold");
    CHECK(swap_gate_idle(60000 + SWAP_FORCE_MS, true, false,
                         swap_gate_last_activity(1000, 500, true, 60000), NULL),
          "the motor on for SWAP_FORCE_MS with no write: release (trackloader)");
}

static void last_activity_is_the_latest_of_its_inputs(void) {
    CHECK_EQ_INT(swap_gate_last_activity(7000, 5000, false, 9000), 7000);   // motor off: its time is ignored
    CHECK_EQ_INT(swap_gate_last_activity(5000, 7000, false, 0), 7000);      // an attempted write
    CHECK_EQ_INT(swap_gate_last_activity(5000, 3000, true, 4000), 5000);    // motor on before the write
    CHECK_EQ_INT(swap_gate_last_activity(0xFFFFFF00u, 0x10u, false, 0), 0x10u);  // across the wrap
}

static void wraparound_is_not_a_special_case(void) {
    const uint32_t last = 0xFFFFF000u;
    CHECK(!swap_gate_idle(last + 1000, false, false, last, NULL), "1 s across the wrap: hold");
    CHECK(swap_gate_idle(last + SWAP_IDLE_MS + 10, false, false, last, NULL), "past the window across the wrap: release");
}

int main(void) {
    RUN(motor_off_and_quiet_releases);
    RUN(motor_on_holds);
    RUN(wgate_asserted_holds);
    RUN(within_the_quiet_window_holds);
    RUN(no_write_activity_past_the_deadline_releases_forced);
    RUN(a_busy_copy_is_never_forced);
    RUN(a_motor_just_switched_on_counts_as_activity);
    RUN(last_activity_is_the_latest_of_its_inputs);
    RUN(wraparound_is_not_a_special_case);
    return REPORT();
}
