// The Amiga drive-ID protocol as floppy.pio's drive_id program answers it,
// select by select, through the pure model in src/drive_id.c (HD spec §5.4).
// This model is the REFERENCE: the PIO program is changed only together with
// it. The PIO itself is verified on the bench (HD bench checklist steps 1, 6).
#include "harness.h"
#include "../src/drive_id.h"

// What the Amiga samples. The board drives a BSS138 gate, so GPIO HIGH pulls
// the bus line LOW (floppy_io.h, bus_gate.c). /RDY is active low, and the
// Amiga counts a select that finds /RDY low as a 1 bit: a DD drive holds it
// low for all 32 reads, 0xFFFFFFFF.
static int rdy_line(const drive_id_model_t *m) { return drive_id_model_rdy_gpio(m) ? 0 : 1; }
static uint32_t sample(const drive_id_model_t *m) { return rdy_line(m) == 0 ? 1u : 0u; }

// Kickstart's read, as the bench showed it: a select with the motor on, a
// motor-off select that resets the drive's ID shifter and is NOT sampled,
// then 32 motor-off selects, each sampled.
static uint32_t amiga_reads_id(drive_id_model_t *m) {
    drive_id_model_select(m, true);  drive_id_model_deselect(m);
    drive_id_model_select(m, false); drive_id_model_deselect(m);     // the reset
    uint32_t id = 0;
    for (int i = 0; i < 32; i++) {
        drive_id_model_select(m, false);
        id = (id << 1) | sample(m);
        drive_id_model_deselect(m);
    }
    return id;
}

static void the_amiga_reads_hd_and_dd(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
    drive_id_model_init(&m, DRIVE_ID_DD);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_DD);
    // Again after the motor has run: a motor-on select starts a fresh answer.
    drive_id_model_level(&m, true);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_DD);
}

static void the_reset_select_carries_no_bit(void) {
    // THE bench finding: whatever the ID, the select that resets it leaves
    // RDY released -- the Amiga does not sample it, and bit 31 goes out on
    // the next one.
    const uint32_t ids[] = { DRIVE_ID_HD, DRIVE_ID_DD };
    for (unsigned k = 0; k < 2; k++) {
        drive_id_model_t m;
        drive_id_model_init(&m, ids[k]);
        drive_id_model_level(&m, true);
        drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
        drive_id_model_select(&m, false);
        CHECK(!drive_id_model_rdy_gpio(&m), "reset select: RDY released");
        drive_id_model_deselect(&m);
        drive_id_model_select(&m, false);
        CHECK_EQ_INT(sample(&m), ids[k] >> 31);
    }
}

static void a_reader_that_samples_the_reset_select_sees_the_spike_phase(void) {
    // Pinned so the phase stays visible: sampling from the reset select on
    // (one early) reads the ID shifted right by one with a 0 on top. HD
    // becomes 0x55555555 -- the word the spike had to put on the wire to
    // look like HD.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    uint32_t id = 0;
    for (int i = 0; i < 32; i++) {
        drive_id_model_select(&m, false);
        id = (id << 1) | sample(&m);
        drive_id_model_deselect(&m);
    }
    CHECK_EQ_INT(id, 0x55555555u);
}

static void power_up_needs_no_motor_on_select(void) {
    // Power-up is "motor was on": the first motor-off select is the reset.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    drive_id_model_select(&m, false); drive_id_model_deselect(&m);
    uint32_t id = 0;
    for (int i = 0; i < 32; i++) {
        drive_id_model_select(&m, false);
        id = (id << 1) | sample(&m);
        drive_id_model_deselect(&m);
    }
    CHECK_EQ_INT(id, DRIVE_ID_HD);
}

static void the_pattern_repeats_while_the_motor_is_off(void) {
    // Kickstart read the ID again while running: a burst of 49 motor-off
    // selects after track reads (spike, HANDOFF). After 32 bits the answer
    // repeats seamlessly -- no second reset.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    amiga_reads_id(&m);
    drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 1u); drive_id_model_deselect(&m);
    drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 0u); drive_id_model_deselect(&m);
    drive_id_model_init(&m, DRIVE_ID_DD);
    amiga_reads_id(&m);
    for (int i = 0; i < 40; i++) {
        drive_id_model_select(&m, false);
        CHECK_EQ_INT(sample(&m), 1u);
        drive_id_model_deselect(&m);
    }
}

static void a_second_burst_after_track_reads_reads_the_same(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    drive_id_model_level(&m, true);
    for (int i = 0; i < 20; i++) { drive_id_model_select(&m, true); drive_id_model_deselect(&m); }
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
}

static void motor_on_selected_is_the_cpu_level_and_released_otherwise(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_level(&m, true);
    CHECK(!drive_id_model_rdy_gpio(&m), "deselected: released whatever the CPU wants");
    drive_id_model_select(&m, true);
    CHECK(drive_id_model_rdy_gpio(&m), "motor on, selected: the CPU level");
    drive_id_model_level(&m, false);
    CHECK(!drive_id_model_rdy_gpio(&m), "follows the CPU while selected");
    drive_id_model_deselect(&m);
    CHECK(!drive_id_model_rdy_gpio(&m), "released on deselect");
}

static void an_id_change_waits_for_the_next_answer(void) {
    // A swap lands mid-answer: the answer in progress finishes as it began,
    // and the new ID starts at the next load -- the 32-bit repeat, or the
    // next reset -- never mid-answer (HD spec §5.4).
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
    drive_id_model_select(&m, false); drive_id_model_deselect(&m);   // reset: DD loaded
    for (int i = 0; i < 10; i++) {
        drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 1u); drive_id_model_deselect(&m);
    }
    drive_id_model_set_id(&m, DRIVE_ID_HD);
    for (int i = 10; i < 32; i++) {
        drive_id_model_select(&m, false);
        CHECK_EQ_INT(sample(&m), 1u);                                  // still DD's answer
        drive_id_model_deselect(&m);
    }
    drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 1u); drive_id_model_deselect(&m); // HD bit 31
    drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 0u); drive_id_model_deselect(&m); // HD bit 30
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
    drive_id_model_set_id(&m, DRIVE_ID_DD);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_DD);                    // and back
}

static void drive_id_for_maps_the_mounted_kind(void) {
    CHECK_EQ_INT(drive_id_for(true), DRIVE_ID_HD);
    CHECK_EQ_INT(drive_id_for(false), DRIVE_ID_DD);
}

int main(void) {
    RUN(the_amiga_reads_hd_and_dd);
    RUN(the_reset_select_carries_no_bit);
    RUN(a_reader_that_samples_the_reset_select_sees_the_spike_phase);
    RUN(power_up_needs_no_motor_on_select);
    RUN(the_pattern_repeats_while_the_motor_is_off);
    RUN(a_second_burst_after_track_reads_reads_the_same);
    RUN(motor_on_selected_is_the_cpu_level_and_released_otherwise);
    RUN(an_id_change_waits_for_the_next_answer);
    RUN(drive_id_for_maps_the_mounted_kind);
    return REPORT();
}
