# Acknowledgements and third-party notices

webadf and the wifi-floppy board are meant for anyone to use, modify and build as they see fit:

- **Software** (the web app, scripts and the wifi-floppy firmware source): the MIT licence, in [`LICENSE`](LICENSE).
- **Hardware** (`wifi-floppy/hardware/`): CERN-OHL-P-2.0 is intended. It becomes effective once the rev B layout
  author has granted it; see the "Licence" section of the README.

They stand on the work below.

## Hardware lineage and design references

- **Nano-Tek** by Stefan Skotte (https://github.com/stefanskotte/Nano-Tek): a compact Gotek-class floppy emulator
  board derived from OpenFlops. The wifi-floppy floppy-bus termination (1 kΩ pull-ups to +5 V on the host-driven
  lines) follows Nano-Tek.
- **OpenFlops** by SukkoPera (https://github.com/SukkoPera/OpenFlops): the open-hardware floppy drive emulator
  Nano-Tek derives from, licensed under CERN OHL v1.2. Used as a design reference for bus termination; no OpenFlops
  design files are included here.
- **Keir Fraser** (https://github.com/keirf):
  - **FlashFloppy**: its Amiga interface behaviour (disk-change and ready semantics) is what our firmware
    re-implements, and its documented MTR pull-up modification matches ours.
  - **Greaseweazle**: its Amiga MFM codec is the independent reference our MFM encoder and HD drive-ID work are
    checked against, and it generated our HFE and HD test fixtures.
  - **amiga-stuff / Amiga Test Kit**: used for drive-ID research and hardware testing.

  All three are released under the Unlicense.
- **amiga-hddlw** by Tube Time / schlae (https://github.com/schlae/amiga-hddlw): its PAL equations are the reference
  for the HD drive-ID answer.
- The Gotek-style buzzer driver, and the original Gotek floppy emulators.
- **Rev B PCB layout** by Shanshe.
- **HxC Floppy Emulator** by Jean-François Del Nero, author of the HFE disk-image format.

## Software included in this repository

- **Monocypher 4.0.2** (`wifi-floppy/firmware/src/vendor/monocypher/`): © 2017-2023 Loup Vaillant, Michael Savage,
  Fabio Scotoni. BSD-2-Clause OR CC0-1.0; see `LICENCE.md` in that directory. Vendored unmodified.
- **xDMS 1.3** by Andre Rodrigues de la Rocha (public domain). `src/lib/archive/dms.ts` is a TypeScript port of it.
- **KiCad Libraries** (footprints and symbols copied into `wifi-floppy/hardware/wifi-floppy-lib.*`): © KiCad Library
  Team, CC-BY-SA 4.0 with the KiCad library exception for designs made with them; see
  `wifi-floppy/hardware/KICAD-LIBRARY-LICENSE.md`.

## Software linked into the firmware binary (.uf2)

The published firmware image contains the following. Their licence texts are in [`licenses/`](licenses/).

- **Raspberry Pi Pico SDK** 2.3.x: © 2020 Raspberry Pi (Trading) Ltd. BSD-3-Clause.
- **lwIP**: © 2001-2004 Swedish Institute of Computer Science. BSD-3-Clause.
- **Mbed TLS**: © The Mbed TLS Contributors. Used under Apache-2.0, chosen from its Apache-2.0 OR GPL-2.0-or-later
  licence.
- **TinyUSB**: © 2018 hathach (tinyusb.org). MIT.
- **cyw43-driver**, including the Infineon CYW43439 Wi-Fi firmware: © 2019-2022 George Robotics Pty Ltd.
  - **Restriction:** the version bundled with Pico SDK 2.3.x is licensed for use with Raspberry Pi semiconductor
    devices (`LICENSE.RP`) or for non-commercial use (`LICENSE`). The wifi-floppy board uses an RP2350, which
    complies.
  - The upstream driver is MIT from v2.0.0; the firmware moves to it once a Pico SDK release includes it.

## Fonts and data

- **Space Grotesk** and **IBM Plex Mono** (web app): SIL Open Font License 1.1.
- **The OLED's 5x7 font** (`wifi-floppy/firmware/src/display.c`): the widely copied classic 5x7 ASCII table, as used
  in the Nokia 5110 and Adafruit GFX example fonts.
- **Disk identification data** from TOSEC, OpenRetro (openretro.org) and Demozoo (demozoo.org), with thanks to
  their volunteer maintainers. The test excerpt `src/lib/demozoo/fixtures/excerpt.sql` quotes a few Demozoo
  platform descriptions, which credit their own sources (old-computers.com, Wikipedia).

## Tools used to verify this project (not distributed)

amitools/xdftool (GPL-2.0-or-later), LHa for UNIX, xDMS, Greaseweazle, KiCad.
