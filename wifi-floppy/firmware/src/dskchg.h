#ifndef DSKCHG_H
#define DSKCHG_H
#include <stdbool.h>
#include <stdint.h>
void dskchg_init(void);
void dskchg_image_inserted(void);
void dskchg_image_ejected(void);
void dskchg_on_step(void);
void dskchg_on_motor(bool on);
void dskchg_poll(void);
bool dskchg_image_in(void);
/** The Amiga has the motor on (latched on SEL0). */
bool dskchg_motor_on(void);
/** ms since boot when the motor last came on (meaningful while it is on). */
uint32_t dskchg_motor_on_ms(void);
#endif
