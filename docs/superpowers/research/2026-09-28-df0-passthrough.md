# DF0 passthrough feasibility (read-only study, 2026-09-28)

Operator's request: "see if we can support another DF0: on the same cable, with a "passthrough" option for the
wififloppy, allowing the physical drive to function as the wififloppy wasnt there".

Backlog entry: HANDOFF.md:2163-2164.

Nothing was edited, built, flashed or measured. Where a claim comes from general Amiga knowledge rather than
this repo, it is marked **(unverified here)**.

---

## 1. How the board sits on the bus today

### Rev B as built (netlist `wifi-floppy/hardware/production/netlist.ipc`, BOM `.../wifi-floppy_bom.csv`)

**J1** (2x17 IDC, Amiga pinout). The odd pins are GND. Signal pins:
2 CHNG, 8 INDEX, 10 SEL0, 12 SEL1, 16 MTR, 18 DIR, 20 STEP, 22 WDATA, 24 WGATE, 26 TRK0, 28 WPROT, 30 RDATA,
32 SIDE, 34 RDY. Pins 4, 6 and 14 are unconnected (netlist.ipc:160-192; 162, 164 and 172 for the unconnected ones).

**Host-driven lines (8): inputs only.** SEL0, SEL1, MTR, DIR, STEP, WDATA, WGATE and SIDE go J1 -> U2
74LVC541A A-side (U2-2..9) -> Y-side -> GP2..GP9 (netlist.ipc:95-96; floppy_io.h:4-12).
- U2's OE1/OE2 (pins 1 and 19) are tied to GND (netlist.ipc:94, 112), so the '541 is always enabled.
- Its outputs face the Pico, never the bus. On the bus side it is only a 5 V-tolerant CMOS input with Ioff,
  powered from 3V3.
- The board **never drives** a host-driven line.

**Pull-ups: R1-R8, 1 kΩ to +5 V, one per host-driven line.** SEL0 = R8, SEL1 = R7, MTR = R6, DIR = R5,
STEP = R4, WDATA = R3, WGATE = R2, SIDE = R1 (netlist.ipc:119-120, 34; HANDOFF.md:2575-2577). The +5 V comes
from J2, the Berg power header. These are the only board parts that load the bus whatever the firmware does.

**Drive-side lines (6): open-drain BSS138 FETs Q1-Q6, one per line.**

| FET | line |
|---|---|
| Q1 | CHNG |
| Q2 | INDEX |
| Q3 | TRK0 |
| Q4 | WPROT |
| Q5 | RDATA |
| Q6 | RDY |

- Wiring: gate from the GPIO, source to GND, drain on the J1 pin (e.g. RDY netlist.ipc:132-134, CHNG :148).
- GPIO HIGH pulls the bus line LOW, i.e. asserts it (floppy_io.h:13-19).
- There are no pull-ups on these six lines on the board. The Amiga motherboard pulls them up (HANDOFF.md:3565-3568).
- There is no gate pull-down resistor either. In reset, or before `gpio_set_function`, the RP2350 pad's default
  pull-down holds each FET off. So an unflashed, resetting or unpowered board already **releases** all six.

**Free GPIOs on rev B.** GP20 (U1-26), GP26, GP27 and GP28 (U1-31/32/34) are unrouted pads (netlist.ipc:72,
77-80). GP14-17 are in the antenna keepout (floppy_io.h:24-31).

### Firmware (select handling)

The board answers **DF0 only**, and every output is gated on SEL0 in PIO time (HANDOFF §4e, HANDOFF.md:3262-3310):

- **`status_gate`** (pio1) owns INDEX/CHNG/WPROT/TRK0. It drives them only while SEL0 is low; otherwise it runs
  `mov pins, null` (floppy.pio:105-115; bus_out.c:45).
- **`flux_out`** pulses RDATA only while SEL0 is asserted (floppy.pio:7-12, 25; main.c:2074).
- **`drive_id`** (pio0) owns RDY when `WF_DRIVE_ID=ON`, the default (CMakeLists.txt:131). It waits on
  **GP2 literally** (`wait 0 gpio 2`, floppy.pio:220-227; static assert in bus_out.c:21). It answers
  DD 0xFFFFFFFF or HD 0xAAAAAAAA on DF0's motor-off selects.
- **Inputs:**
  - `step_dir` latches SEL0 together with DIR at STEP's fall (main.c:2096; bus_gate.c:19).
  - `sel_mtr` latches MTR on SEL0's fall (main.c:2107).
  - The WGATE ISR ignores writes while SEL0 is high (main.c:819).
- **Drive selection is not configurable.** SEL0 is compiled in. SEL1 is wired and pulled up on rev B but no
  firmware reads it as "ours". HANDOFF.md:3307: "The board is DF0 only. Every program takes the select pin as a
  parameter, so becoming DF1 ... is small".

### What the board asserts when it "has nothing to do"

The board is **not** absent when no disk is mounted. When SEL0 is asserted:
- It asserts **CHNG** at power-on and whenever no image is in (dskchg.c:8, 44-50).
- It boots with **TRK0 and WPROT** asserted (main.c `bus_out_init(... TRK0 | WPROT)`, just after main.c:2000).

So on today's firmware, a physical drive answering SEL0 on the same cable would see its CHNG, WPROT and TRK0
OR-ed with the board's. The Amiga would report no disk or write-protected. A real DF0 cannot share the cable
today, even with an empty board.

---

## 2. What "another DF0 on the same cable" means physically

- **Same cable = multi-drop, straight ribbon.** Every conductor goes to both connectors. The Amiga floppy bus is
  open-collector both ways, and several drives share every line except the per-drive select
  (docs/decisions/2026-09-20-floppy-bus-pullups.md:180-195). The 34-pin cable must be **straight, with no PC
  twist** **(unverified here, standard knowledge)**. The PC twist swaps conductors 10-16, so the drive past the
  twist would get host MTR (16) on its pin 10. The repo already records a reversed ribbon on the A5000 making
  every input read low (HANDOFF.md:4569-4571).
- **Select lines.** SEL0 is pin 10 and SEL1 is pin 12 on the board (netlist.ipc:168, 170).
  - A2000-style internal wiring carries SEL0 and SEL1 on one ribbon; each drive is jumpered to DS0 or DS1
    **(unverified here)**.
  - Whether the **A500 internal connector** and the **A5000's Berg-side header** carry SEL1 on pin 12 is **not
    recorded in the repo**. An external DF1 on an A500 comes through the DB23 port.
  - It must be checked by continuity: Amiga pin 12 to the SEL1 source.
- **"Another DF0" = two devices on SEL0.** Both would take every select, step, motor latch and write, and both
  would drive CHNG/WPROT/TRK0/INDEX/RDY/RDATA. Open-collector lines wired-OR, so the Amiga reads the union, and
  RDATA becomes two flux streams mixed. Exactly one of them may answer SEL0 at a time. Since the physical drive
  cannot be told to be quiet, that means either:
  - the board steps aside (passthrough), or
  - the physical drive's pin 10 is disconnected.

  **An empty physical drive is not harmless.** With no disk, a real drive holds CHNG asserted until a step with
  a disk in, and usually asserts WPROT **(unverified here, standard drive behaviour)**. That alone makes the
  board's DF0 look empty or write-protected.
- **Drive ID, DF0 vs DF1-3.**
  - Kickstart does read DF0's ID at power-on (33 selects in ~141 µs; HANDOFF.md:3329-3335). It treats DF0 as
    present whatever it gets (research doc :365-376).
  - For DF1-3, an ID of 0x00000000 means "no drive" and 0xFFFFFFFF means a DD drive
    (docs/superpowers/research/2026-09-24-hfe-and-hd-floppies.md:328-333). So a board acting as DF1 **must**
    answer the ID. The `drive_id` responder exists but only for SEL0.
  - If both devices answered DF0's ID, the result is an OR: the board's HD 0xAAAAAAAA | the physical DD
    0xFFFFFFFF reads as DD.
- **What the Amiga expects from DF0 at boot:**
  - an ID read at power-on;
  - then disk-change polling (the periodic click);
  - booting from DF0 if its disk is bootable.

  Kickstart 2.0+ Early Startup can boot from DF1; 1.3 boots DF0 only **(unverified here)**. The board must be
  in its final mode **before** the Kickstart ID read. Any passthrough setting must therefore be persisted and
  applied before `bus_out_init` asserts anything.

---

## 3. Is a passthrough mode achievable?

### 3a. Firmware only, rev B as built: YES for "board steps aside"

Every output the board has is an open-drain FET that the firmware can hold off, and the board drives no
host-driven line. So "as if the board were not there" is reachable without hardware changes.

**What passthrough must do:**
1. **Outputs:**
   - Release INDEX/CHNG/WPROT/TRK0 (`status_gate` pushes 0, or stops after `mov pins, null`).
   - Stop RDATA pulses (flux_out off or pad released).
   - Release RDY (drive_id stopped after `mov pins, null`).
   - Statically released pads can simply be handed back to SIO low or input-with-pull-down. The "~ms release
     via pull-down" concern (HANDOFF.md:3400-3401) matters only for per-select gating, not for a mode.
2. **Write capture off. This is the dangerous one.** The WGATE ISR accepts any write made while SEL0 is low
   (main.c:819). In passthrough, the physical drive's writes would be captured, **applied to the board's
   mounted image and uploaded as a new library version**. The same class of bug is recorded in
   HANDOFF.md:3284-3286 and :3395-3396.
3. **Keep following STEP** (read-only) so `cur_cyl` stays equal to the shared head position when the board
   comes back. Ignore MTR and SIDE for any output purpose.
4. **Persist the mode** (a new field or sector; `config_store` holds Wi-Fi and pairing only, config_store.h:21-25).
   Apply it before `bus_out_init`, so the Kickstart power-on ID read sees only the physical drive.
5. **Handover without confusing trackdisk.** Enter passthrough like an **eject**: the board asserts CHNG
   (dskchg_image_ejected), waits at least one Amiga poll with the motor off and WGATE idle, then releases.
   Leave it like an **insert**: CHNG asserted until the first step (dskchg_image_inserted). Never switch while
   the motor is latched on or WGATE is active.

**PIO budget.** pio1 has 31 of 32 instructions used in a sniff build, and pio0 29 of 32 (HANDOFF.md:3292-3295;
floppy.pio:220-222). No new PIO instructions are needed, because passthrough is a mode change done by the CPU:
stop or re-enable state machines, and swap pad functions.

**What cannot be released on rev B:**
- **R1-R8, the 1 kΩ pull-ups to +5 V on all eight host-driven lines.** They are static and not switchable. With
  a physical drive's own termination in parallel, each Amiga driver sinks up to ~5 mA more (1k at 5 V).
  Evidence so far:
  - Rev A2 had 1k on WGATE/WDATA/MTR and ran happily beside a real external DF1 on an A500 (HANDOFF.md:3262-3266).
  - The other five lines (SEL0, SEL1, DIR, STEP, SIDE) with a second terminated drive are **unmeasured**.
  - The A5000 has no pull-ups of its own (HANDOFF.md:4490), so there the board's resistors may be the only
    termination apart from the drive's own.
- **Parasitics:** the '541 input capacitance and leakage, six FET drain capacitances, and the stub. These are
  negligible at 2 µs (DD) and probably at 1 µs (HD) bit cells, but not measured.
- **Power:** the board draws from the same Amiga floppy +5 V (J2) as the physical drive. This is a budget item
  to check, not a signal problem.

There is **no** level shifter without OE facing the bus, no push-pull bus driver, and no motor-line coupling.
The drive-ID responder is firmware and is released like the others.

**The limit of firmware only.** Passthrough works, but the reverse does not. With the physical drive still on
SEL0, the board **cannot** be DF0: the physical drive answers too, even empty (§2). So a firmware-only toggle
is one way: "board on" requires unplugging the physical drive's connector. Do not use the drive's power as the
switch. An unpowered drive's termination sits on a dead rail and loads the host lines **(unverified here)**.

### 3b. Firmware plus a bodge on rev B: a real two-way toggle

- Break **only the physical drive's pin 10** (cut conductor 10 at its drop, or use an inline adapter) and fit
  an SPDT switch:
  - **Position "physical":** drive pin 10 goes to host SEL0. The board is in passthrough.
  - **Position "board":** drive pin 10 goes to a 1k pull-up to +5 V (drive deselected). If the cable carries
    SEL1, it can go to host pin 12 instead, which makes the physical drive **DF1** next to the board's DF0.
    That already works today (HANDOFF §4e).
- A second pole to a free GPIO (GP26, U1-31, or GP20, U1-26), with an internal pull-up, lets the firmware
  **follow the switch automatically**: eject handshake, then release, then the reverse. The mode can never
  disagree with the wiring.
- No new chips. Reversible.

### 3c. Rev C: the board switches the drive itself

- Add **J5, a second 34-pin "DRIVE" header**. All conductors are straight from J1 except pin 10, which the
  board drives:
  - a BSS138 on J5-10 plus a 1k pull-up, with gate = NOR(SEL0_buffered_n, PASS_EN_n) from one 74LVC1G02; or
  - a PIO copy of SEL0 onto a spare GPIO (~33 ns latency against ≥1 µs selects).
- Optionally a second FET from host SEL1 (pin 12), so the physical drive becomes DF1 when the board is DF0.
- Control GPIO: GP20 or GP26-28.
- Pick the fail-safe default deliberately:
  - a pull resistor on PASS_EN so a board held in reset hands DF0 to the physical drive; or
  - a normally-closed relay on pin 10, if "board dead = drive works" must also cover an unpowered board.
- `hw_verify.py` checks the netlist against firmware, so it needs the new pin.
- This is also where the **R1-R8 pull-ups** could become DNP or jumpered, to be decided after the bench
  measurement below.

---

## 4. Alternatives the operator may actually want

| Option | What it takes |
|---|---|
| **A. Board DF0, physical drive DF1 on the same ribbon** | Works **today** (HANDOFF.md:3262-3266). Needs SEL1 on pin 12 of the cable and the drive jumpered or wired to DS1 (many stock Amiga internal drives are fixed at DS0 **(unverified here)**, so the drive's pin 10 may need to come from cable pin 12 via an adapter). No firmware change. Cannot boot the physical disk without Early Startup (KS 2.0+). |
| **B. Physical DF0, board DF1** | Firmware: select pin as a runtime parameter in `status_gate`/`flux_out`/`step_dir`/`sel_mtr` (already parameters); `drive_id` rewritten off literal GP2 (floppy.pio:227, bus_out.c:21); WGATE ISR and IRQ on the chosen pin (main.c:819, :2135); `bus_step_decode` bit index (bus_gate.c:19). The DF1 ID answer is **mandatory** (0 = no drive). Needs SEL1 on the cable. Boot from the board then needs Early Startup. |
| **C. Toggle "board is DF0" / "physical is DF0"** (the literal request) | §3b switch bodge on rev B plus firmware passthrough with the eject/insert handshake, or §3c on rev C. With SEL1 available, the switch's second position gives A. |
| **D. Passthrough only, board parked** | §3a, firmware only. One-way unless a connector is unplugged. |

---

## 5. Recommendation

**The smallest path that works is D, then C on the bench, with no rev C yet.**
1. **Firmware passthrough mode** (§3a):
   - release all six outputs;
   - hard-disable write capture;
   - keep following STEP;
   - persist the mode, applied before `bus_out_init`;
   - eject/insert handshake on each switch;
   - never switch while the motor is on or WGATE is active;
   - show it on the OLED and in the web app.

   Host-test the mode in `bus_gate` style. Add a sniffer check: "nothing asserted in passthrough"
   (`bus_sniff_violation`, bus_gate.h:40-42).
2. **Switch bodge** on the physical drive's pin 10, with its second pole on GP26 so firmware follows it (§3b).
   This gives the real two-way toggle on rev B.
3. Decide on a rev C J5 plus the board-driven select only after the bench shows the operator uses the toggle.

**Risks:**
- Write capture of the physical drive's writes (library corruption) if passthrough gating is missed.
- Trackdisk's cached state if the handover skips the CHNG handshake. Writes after a silent swap could corrupt
  either disk.
- Extra 1k loading with two terminated devices.
- The switch flipped mid-access.
- A PC-twisted or reversed ribbon.
- HD ID read as DD whenever both devices answer.

**Bench measurements owed (operator only):**
1. **Continuity:** does SEL1 reach pin 12 on the A500 internal connector and on the A5000 Berg-side header?
   Also confirm the 3-drop ribbon is straight (the J1 pin 10 -> pin 9 reversal check, HANDOFF.md:4570).
2. **VOL on each host-driven line** (SEL0, SEL1, MTR, DIR, STEP, SIDE, WGATE, WDATA) with the board **and** the
   physical drive on the cable, both powered: it should be well under 0.8 V, ideally under 0.5 V. Repeat with
   the board unpowered or unplugged for a baseline.
3. **Board unflashed or held in reset, physical drive on SEL0:** Workbench boots from the physical DF0, and
   read and write work. This proves the hardware already "is not there" when released.
4. **Firmware passthrough build:**
   - boots from the physical disk;
   - a write to the physical disk creates **no** library version (and no `write:` capture lines);
   - the sniffer shows 0 board outputs asserted.
5. **Toggle with the switch bodge**, both directions: the Amiga sees an eject and then an insert, with no read
   errors and no stale directory. Also a cold power-on in each position.
6. **Rev B's physical drive empty and deselected** (switch at "board"): the board's DF0 works, including HD ID
   and writes.
