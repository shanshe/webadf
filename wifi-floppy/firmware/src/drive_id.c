#include "drive_id.h"

// Each function is one path through floppy.pio's drive_id program; the
// comments name the instructions they stand for. Host-test-only: the device
// build does not compile this file (CMakeLists.txt) -- on the board the PIO
// program IS the behaviour, and this is its reference.

void drive_id_model_init(drive_id_model_t *m, uint32_t id) {
    m->id = id;
    m->shifter = 0;
    m->bits_left = 0;
    m->motor_on = true;      // the program starts at on_released: power-up is "motor was on"
    m->selected = false;
    m->level = false;        // X = 0
    m->rdy = false;
}

void drive_id_model_set_id(drive_id_model_t *m, uint32_t id) {
    m->id = id;              // instr_mem[reset_load], instr_mem[repeat_load] rewritten
}

void drive_id_model_select(drive_id_model_t *m, bool mtr_on) {
    m->selected = true;
    if (mtr_on) {                         // jmp !y, on_selected
        m->motor_on = true;
        m->rdy = m->level;                // mov pins, x
        return;
    }
    if (m->motor_on) {                    // reset_load: mov osr, <the ID>
        m->motor_on = false;
        m->shifter = m->id;
        m->bits_left = 32;
        m->rdy = false;                   // jmp bit_done: no bit, RDY stays released
        return;
    }
    m->rdy = (m->shifter >> 31) != 0;     // id_bit: out pins, 1
    m->shifter <<= 1;
    m->bits_left--;
}

void drive_id_model_deselect(drive_id_model_t *m) {
    m->selected = false;
    m->rdy = false;                       // mov pins, null
    if (!m->motor_on && m->bits_left == 0) {   // jmp !osre falls through: repeat_load
        m->shifter = m->id;
        m->bits_left = 32;
    }
}

void drive_id_model_level(drive_id_model_t *m, bool assert) {
    m->level = assert;                    // exec'd `set x, level` (bus_out.c)
    if (m->selected && m->motor_on) m->rdy = assert;   // on_selected: mov pins, x
}

bool drive_id_model_rdy_gpio(const drive_id_model_t *m) {
    return m->rdy;
}
