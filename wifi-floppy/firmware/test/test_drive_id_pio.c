// Pins floppy.pio's drive_id PROGRAM (not just the model in drive_id.c) to
// what bus_out.c assumes about it (HD spec §5.4, final-fix F5).
//
// drive_id.c/test_drive_id.c model the PROTOCOL: what the answer looks like,
// select by select. Neither one looks at the actual PIO instruction words,
// so a hand-edit of floppy.pio's drive_id program that kept the protocol but
// moved reset_load/repeat_load, or changed what "the ID load" assembles to,
// would pass every test above while silently breaking bus_out.c's
// id_write_loads(), which pokes raw instruction words (`0xa0e6` for
// `mov osr, isr` = HD, `0xa0eb` for `mov osr, ~null` = DD) straight into
// instr_mem[drive_id_offset_reset_load] and
// instr_mem[drive_id_offset_repeat_load]. This test is the tripwire for that.
//
// bus_out.c itself is device-only (it holds PIO/spinlock register state) and
// is excluded from the host build (test/run.sh), so it cannot be linked here
// and exercised directly. Two checks instead:
//
//  1. The golden array below is drive_id_program_instructions[] as pioasm
//     currently emits it (wifi-floppy/firmware/build/floppy.pio.h, generated
//     by `pico_generate_pio_header` during `pnpm firmware:build`), plus the
//     two offset #defines from the same file. Regenerate it by running
//     `pnpm firmware:build` (or `cmake --build` the firmware build dir) and
//     copying build/floppy.pio.h's drive_id_program_instructions[],
//     drive_id_offset_reset_load and drive_id_offset_repeat_load here.
//  2. If that generated header is present on disk right now (a prior build
//     was run in this tree), this test reads it as TEXT -- not #include, as
//     the header pulls in hardware/pio.h, which needs the pico-sdk on the
//     include path -- and compares every word live, so drift is caught
//     automatically whenever a device build has happened, not just when a
//     human remembers to refresh the golden array.
//
// Changing the PIO requires changing drive_id.c's model and
// test_drive_id.c in the same commit -- and, per this file's comment above,
// this golden array too.
#include "harness.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// drive_id_program_instructions[], as pioasm currently emits it. See the
// file header above for how to regenerate this.
static const uint16_t golden[16] = {
    0xa003, //  0: mov    pins, null
    0x2702, //  1: wait   0 gpio, 2              [7]
    0xa040, //  2: mov    y, pins
    0x006e, //  3: jmp    !y, 14
    0xa0e6, //  4: mov    osr, isr               <- reset_load
    0x0007, //  5: jmp    7
    0x6001, //  6: out    pins, 1
    0x2082, //  7: wait   1 gpio, 2
    0xa003, //  8: mov    pins, null
    0x00eb, //  9: jmp    !osre, 11
    0xa0e6, // 10: mov    osr, isr               <- repeat_load
    0x2702, // 11: wait   0 gpio, 2              [7]
    0xa040, // 12: mov    y, pins
    0x0086, // 13: jmp    y--, 6
    0xa001, // 14: mov    pins, x                (.wrap_target)
    0x00c0, // 15: jmp    pin, 0                 (.wrap)
};

// bus_out.c's id_write_loads() rewrites exactly these two words in, never
// anything else. Named here so a change to either encoding is visible by
// name, not just as a hex diff.
#define DRIVE_ID_LOAD_HD  0xa0e6u   // mov osr, isr    (pio_encode_mov(pio_osr, pio_isr))
#define DRIVE_ID_LOAD_DD  0xa0ebu   // mov osr, ~null  (pio_encode_mov_not(pio_osr, pio_null))
#define DRIVE_ID_OFFSET_RESET_LOAD  4u
#define DRIVE_ID_OFFSET_REPEAT_LOAD 10u

// Independent of golden[] and of bus_out.c (which is not linked into this
// host build): the RP2040/RP2350 PIO MOV instruction's 16 bits, computed
// from the datasheet's field layout, not copied from either source. If this
// ever disagrees with DRIVE_ID_LOAD_HD/DD above, one of the two hex literals
// was mistyped, independently of whether golden[] agrees with them.
//   [15:13] opcode (MOV = 101)
//   [12:8]  delay/side-set (0: neither instruction has a [n] or side-set)
//   [7:5]   destination (OSR = 111)
//   [4:3]   op (00 none, 01 invert)
//   [2:0]   source (ISR = 110, NULL = 011)
static uint16_t encode_mov_osr(unsigned op, unsigned src) {
    return (uint16_t)((0x5u << 13) | (0x7u << 5) | ((op & 3u) << 3) | (src & 7u));
}

static void the_load_words_are_what_the_pio_encoding_says(void) {
    CHECK_EQ_INT(encode_mov_osr(0, 6 /* ISR */), DRIVE_ID_LOAD_HD);
    CHECK_EQ_INT(encode_mov_osr(1, 3 /* NULL, inverted */), DRIVE_ID_LOAD_DD);
    // And the golden array (what pioasm actually emitted) carries the HD
    // load at both offsets, matching the .pio source's `mov osr, isr` at
    // reset_load and repeat_load -- bus_out.c overwrites one or both at
    // runtime, but the source's own default is HD at both.
    CHECK_EQ_INT(golden[DRIVE_ID_OFFSET_RESET_LOAD], DRIVE_ID_LOAD_HD);
    CHECK_EQ_INT(golden[DRIVE_ID_OFFSET_REPEAT_LOAD], DRIVE_ID_LOAD_HD);
}

// Read build/floppy.pio.h as text (no #include: it needs hardware/pio.h,
// which needs the pico-sdk on the include path, and this is a host test) and
// pull out drive_id_program_instructions[]'s 16 hex words plus the two
// offset #defines, comparing them against golden[] above. Present only after
// a device build has run in this tree (build/ is gitignored -- global
// constraints), so its absence is reported, not failed.
static void the_generated_header_matches_the_golden_array_when_present(void) {
    FILE *f = fopen("../build/floppy.pio.h", "r");
    if (!f) {
        printf("  (skip: ../build/floppy.pio.h not present -- run `pnpm firmware:build` first "
               "to check live, not just against the golden array)\n");
        return;
    }
    char line[256];
    int reset_load = -1, repeat_load = -1;
    uint16_t got[16];
    int got_count = 0;
    int in_array = 0;
    while (fgets(line, sizeof(line), f)) {
        if (strstr(line, "drive_id_offset_reset_load")) sscanf(line, "%*s %*s %d", &reset_load);
        if (strstr(line, "drive_id_offset_repeat_load")) sscanf(line, "%*s %*s %d", &repeat_load);
        if (strstr(line, "drive_id_program_instructions[] = {")) { in_array = 1; continue; }
        if (in_array) {
            if (strstr(line, "};")) break;
            unsigned word;
            // Lines are either "    0xNNNN, // ..." or a bare ".wrap_target"/
            // ".wrap" comment line with no leading hex -- skip those.
            char *p = line;
            while (*p == ' ') p++;
            if (sscanf(p, "0x%x,", &word) == 1) {
                if (got_count < 16) got[got_count++] = (uint16_t)word;
            }
        }
    }
    fclose(f);

    CHECK_EQ_INT(got_count, 16);
    CHECK_EQ_INT(reset_load, (int)DRIVE_ID_OFFSET_RESET_LOAD);
    CHECK_EQ_INT(repeat_load, (int)DRIVE_ID_OFFSET_REPEAT_LOAD);
    for (int i = 0; i < got_count && i < 16; i++) CHECK_EQ_INT(got[i], golden[i]);
}

int main(void) {
    RUN(the_load_words_are_what_the_pio_encoding_says);
    RUN(the_generated_header_matches_the_golden_array_when_present);
    return REPORT();
}
