#include "swap_gate.h"

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
