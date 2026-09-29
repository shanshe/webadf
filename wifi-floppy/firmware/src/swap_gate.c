#include "swap_gate.h"

static uint32_t later(uint32_t a, uint32_t b) { return (int32_t)(b - a) > 0 ? b : a; }

uint32_t swap_gate_last_activity(uint32_t write_ms, uint32_t wgate_ms,
                                 bool motor_on, uint32_t motor_on_ms) {
    uint32_t t = later(write_ms, wgate_ms);
    return motor_on ? later(t, motor_on_ms) : t;
}

bool swap_gate_idle(uint32_t now, bool motor_on, bool wgate_asserted,
                    uint32_t last_activity_ms, bool *forced_out) {
    const int32_t quiet = (int32_t)(now - last_activity_ms);
    const bool forced = quiet >= (int32_t)SWAP_FORCE_MS;
    if (forced_out) *forced_out = forced;
    if (forced) return true;
    if (motor_on) return false;
    if (wgate_asserted) return false;
    return quiet >= (int32_t)SWAP_IDLE_MS;
}
