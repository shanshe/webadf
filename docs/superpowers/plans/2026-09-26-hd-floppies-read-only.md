# HD floppies, read-only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 1.76 MB HD ADF in the library boots and loads on a real Amiga through the board, read-only, while DD, HFE and DF1 behave exactly as before.

**Architecture:** The server recognises HD by one rule (`imageFormat = 'adf'` and 1,802,240 bytes) and sends the board a **WFAD** container (a 16-byte header plus the raw ADF) instead of WFMF. The board keeps each track's 11,264 ADF bytes in its existing PSRAM slot, tags the slot `ADF_HD`, and encodes a track to MFM on core0 when the head arrives (~4 ms). A PIO program answers the Amiga's drive-ID read on RDY: HD `0xAAAAAAAA` while an HD disk is mounted, DD otherwise. WPROT is forced for HD and captured writes to it are discarded. The server mounts HD only on a board that reports `playsHd`, stored in a new `devices.plays_hd` column.

**Tech Stack:** Next.js 16 (App Router), Drizzle + Neon Postgres, Vercel Blob, vitest, Playwright; RP2350 firmware in C (pico-sdk ≥ 2.3.0, PIO), host-tested with `wifi-floppy/firmware/test/run.sh`; Greaseweazle (independent MFM oracle) and xdftool (amitools 0.4, test disk).

**Spec:** `docs/superpowers/specs/2026-09-26-hd-floppies-read-only-design.md` (binding; read it before any task). Spike: branch `spike/hd-floppy` (commits `c996ee6`, `3aa7fc6`, worktree `.claude/worktrees/hd-spike`), results in HANDOFF backlog "HD floppies -- 2026-09-26 SPIKE DONE".

## Global Constraints

- **HD rule:** an HD disk is a disk row with `imageFormat === 'adf'` AND `sizeBytes === 1_802_240`; DD is 901,120. `adfDensity(sizeBytes): 'dd' | 'hd' | null` in `src/lib/disk-format.ts` is the only TypeScript code that interprets those sizes. Its SQL twin, `isHdAdfSql()` in `src/lib/disk-format-sql.ts`, exists for WHERE clauses and aggregates.
- **WFAD** (all integers little-endian): offset 0 magic `WFAD` = `0x44414657`; 4 version = 1; 8 tracks = 160; 12 sectors per track = 22; 16 the ADF, track-major (track = cylinder × 2 + head), 22 × 512 bytes each. Total **1,802,256** bytes. The writer throws on any other input size. The loader rejects the whole image for any other version, geometry or body length, including one byte too many.
- **Copy, verbatim:** `Update the drive's firmware to play HD disks` (mount refusal, every entry point) and `HD disks can't be browsed in the browser yet` (file browser). Both have no trailing period, as in the spec.
- **Reasons:** `hd_unsupported` (mount refused), `hd_read_only` (writes refused), `hd_not_browsable` (file GET refused).
- **Capability:** the status body carries `"playsHd":true`, and an absent key means false. The column is `devices.plays_hd boolean not null default false`. A report that names its firmware version but carries no `playsHd` sets it to false; this is the `trackMaxBytes` rule.
- **HD track:** 22 sectors, 202,688 bits, 25,336 MFM bytes. The SRAM staging size is `TRACK_BUF_BYTES = 25,344`. The PSRAM stride `TRACK_MAX_BYTES` stays **14,336**, `SLOT_COUNT` stays 2, and the 2 MiB firmware stage is unchanged.
- **Drive ID:** HD `0xAAAAAAAA`, DD `0xFFFFFFFF`. The select that resets the ID (the first motor-off select after the motor was on, or after power-up) **carries no bit**, and bit 31 goes out on the next motor-off select. Only SEL0 is looked at. **Polarity:** a bit is 1 when `/RDY` is low on the bus, and `/RDY` is low when GPIO 12 is HIGH (BSS138 gate: `floppy_io.h:13` "GPIO HIGH -> bus line pulled LOW (asserted)", `bus_gate.c:12` "Bit set = pin HIGH = BSS138 on = bus line pulled low = asserted"). The model's `rdy` field means "asserted", which is GPIO high. The bench workaround word `0x55555555` is never used.
- **Kill switch:** CMake option `WF_DRIVE_ID`, default **ON**. With OFF there is no responder and no `playsHd` in the status.
- **Firmware version 1.4.0.** Publishing to the release registry and flashing the board are **controller-only**; no task does either.
- **Out of scope:** HD in `.dms`, HD HFE, Amiga writes to HD, browser editing, history and blank HD disks. Kickstart 3.0+ is required, and this is documented, not worked around.
- **Repo rules:** stage explicit paths only, never `git add -A` or `git add .`, and never `git stash`. Never print, copy or commit anything under `~/.webadf/board-backups/`. No real disk image, or anything derived from one, is committed; fixtures are synthetic. Before editing a Next.js route or page, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, and `03-layouts-and-pages.md` for the page (AGENTS.md: this Next.js has breaking changes). Match the surrounding code's style and comment density: comments here explain *why*, and cite the spec section.
- **Database:** `pnpm db:push` is forbidden. Generate the migration with `pnpm db:generate --name plays_hd` and hand-edit it to the guarded `ADD COLUMN IF NOT EXISTS` form. The **controller** applies it to the live database; no task does.
- **e2e:** it runs against the **live production database**. Use `PORT=3100`, run in the **foreground**, and keep every invocation under 9 minutes (split by spec file). Never run two e2e runs at once. Never `pkill`/`killall` by pattern; stop only PIDs you started yourself.
- **Firmware:** host tests are `wifi-floppy/firmware/test/run.sh` (the same as `pnpm firmware:test`) and the device build is `pnpm firmware:build`. Build variants go in a directory **outside the repo**, e.g. `${TMPDIR:-/tmp}/wf-build-<name>`, because only `wifi-floppy/firmware/build/` is gitignored.
- **Commits:** every commit message ends with the two attribution lines shown in each task's commit template (`Co-Authored-By: …` and `Claude-Session: …`) as its last paragraph. If the controller gives you different lines for your session, use those.

## Review Focus

1. **A board that rolls back from 1.4.0 to 1.3.x (a failed trial boot) while an HD disk is desired.** Its next status report names its firmware without `playsHd`. The server must drop `plays_hd` to false and refuse the next HD mount instead of sending a disk the old firmware reads with DD geometry. Pinned in Task 2 (vitest `recordStatus`) and Task 4 (e2e: report without `playsHd`, then mount is 409).
2. **An HD disk whose library row says `writeProtected = false`** (set by a direct DB edit, or by a PATCH racing the new check). The board must still receive `writeProtected: true`, and WPROT must be asserted on the board regardless. Pinned in Task 2 (vitest `readDesired`), Task 4 (e2e poll after forcing the row writable) and Task 8 (host `write_back_wprot`).
3. **The Amiga seeking quickly across an HD disk.** Each step changes `want_track` while an encode may be under way. What is streamed must always be the encoding of the track asked for, never a previous track's bytes tagged with the new number. Pinned in Task 7 (host test: out-of-order and repeated `track_cache_get` calls, every answer checked against Greaseweazle's digest for that track).
4. **A WFAD that is almost right:** one byte too many, one byte short, 11 sectors, or 159 tracks. Each must reject the whole image, leave the slot empty and reset its kind. Pinned in Task 6.
5. **Swapping DD → HD → DD without rebooting the Amiga.** The ID word may change only at the start of an answer (the reset or the 32-bit repeat), never mid-answer, and a DD disk after an HD one must answer DD again. Pinned in Task 9 (model tests `an_id_change_waits_for_the_next_answer` and the swap-block wiring); whether Kickstart re-reads the ID at all is bench step 9.

## Rulings made while planning (reviewers: these are deliberate)

- **Where the encode runs (spec §5.2 required this to be settled now).** `track_cache_get` has exactly one caller: `main()`'s core0 service loop, `main.c:2262` (`const uint8_t *mfm = track_cache_get(want, &bits);`). That call runs in **thread mode, not in an interrupt handler**. The ISRs only write state: `gpio_isr` on a SIDE edge (`main.c:787-790`) and `step_pio_isr` set `want_track`, and `dma_irq` (`main.c:413`) only re-arms the DMA from `track_words`. So the HD encode runs **inside `track_cache_get`, on core0's loop**, straight into the idle half of `track_cache.c`'s double buffer. `start_streaming` then repacks it into `track_words`, and only then is the old stream aborted. The previous track keeps streaming during the encode. For ~4–5 ms core0's loop does nothing else: `flux_capture_poll`, `dskchg_poll`, the NFC and display pumps and the WPROT reinsert logic all wait. This is acceptable because HD is write-protected (no capture to drain) and the spin-up and reinsert timings are hundreds of ms. During a long seek, intermediate tracks may be encoded and discarded; the last one is ready ≤ ~9 ms after the final step, inside the ~15 ms settle budget. Nothing moves to another context.
- **The device-facing write route answers `{ error: 'write_protected', reason: 'hd_read_only' }`,** not `error: 'hd_read_only'`. `uploader.c:322` acts only on `write_protected` (it parks and forces WPROT). Any other 409 word falls through to "transient" and is retried forever (`uploader.c:342`). The spec's "reason `hd_read_only`" is honoured in the `reason` field. The browser-facing routes answer `error: 'hd_read_only'`.
- **An NFC tap of an HD disk on a board without `playsHd` goes out as outcome `too_long`.** The only boards ever refused run firmware older than 1.4.0 (or `WF_DRIVE_ID=OFF`), and `device_client.c:1339-1345` turns any outcome word it does not know into `DC_TAP_FAILED`, which is "no answer": the silent drop the spec forbids. `too_long` shows "Tag: tracks too long", and its remedy (update the firmware) is the same. `tapRefusalOutcome` in `src/lib/nfc/rules.ts` holds this rule.
- **Drive chips do not mount.** `drive-chips.tsx` offers only Go to disk, Protect and Eject. The one web mount path is `POST /api/devices/[id]/mount`, which `mount-action.tsx` toasts with the body's `reason`. The chips' **Protect** item is disabled for HD (`readOnly: 'HD'`), like HFE.
- **The WFAD "golden file"** is the spec table's 16 header bytes spelled out literally in both test suites (TS and C), plus body identity. A committed 1.8 MB golden file would only be the writer's own output.
- **The end-to-end firmware oracle is Greaseweazle.** `scripts/adf-mfm-hd-fixtures.py` writes 8 full-track fixtures (committed, as in the spike) and `prng-digests.txt` (160 lines of `<track> <sha256>`, committed, about 10 KB). The C tests regenerate the same synthetic disk with the same xorshift32 and compare every track's sha-256.
- **The drive-ID PIO differs from the spike's in two places:** the phase fix, and how the CPU talks to it. (a) The CPU's RDY level reaches the program through an exec'd `set x`, not the TX FIFO. The spike's FIFO is read only while DF0 is selected with the motor on, so level changes made while it waits pile up, and past eight the newest is dropped. (b) DD and HD are chosen by rewriting the two load instructions (`mov osr, ~null` for DD, `mov osr, isr` for HD with ISR preloaded to `0xAAAAAAAA`), so no FIFO word is ever needed. The program is 16 instructions and stays on **pio0**, the spike's bench-proven placement: flux_out (8) + flux_in (7) + drive_id (16) = 31 of 32 slots. The spike's diagnostic `sel_off_count` on pio2 is not carried.
- **Heap low-water log.** Spec §7 bench step 10 reads it, and none exists today, so Task 7 adds one.
- **The Amiga-side check of the known file.** Workbench 3.1 ships no checksum tool. The known file is 20,000 numbered text lines (560,000 bytes, sha-256 recorded by the script). Pass means `Copy` completes with no error, `List` shows exactly 560000 bytes, and `Type` ends at line 20000. trackdisk verifies every sector's MFM data checksum on read, so a corrupt sector fails the copy rather than passing silently.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/adfmfm/constants.ts` (modify) | HD and WFAD constants |
| `src/lib/adfmfm/wfad.ts` (new) + `wfad.test.ts` (new) | `writeWfad` |
| `src/lib/adfmfm/index.ts` (modify) | exports |
| `src/lib/disk-format.ts` (modify) + test | `adfDensity`, `isHdAdf`, `isServable` |
| `src/lib/disk-format-sql.ts` (new) | `isHdAdfSql()` |
| `src/app/api/device/image/[sha256]/route.ts` (modify) | WFAD for HD |
| `src/db/schema/devices.ts` (modify), `drizzle/0026_plays_hd.sql` + meta (generated) | `plays_hd` |
| `src/app/api/device/status/route.ts` (modify) | accept `playsHd` |
| `src/lib/mount.ts` (modify) + `mount-hd.test.ts` (new) | `recordStatus`, `setDesired` (`hd_unsupported`), `readDesired` (forced WP) |
| `src/lib/hd-messages.ts` (new) | every HD sentence |
| `src/app/api/devices/[id]/mount/route.ts` (modify) | 409 `hd_unsupported` |
| `src/lib/nfc/rules.ts`, `store.ts` (modify) | tap refusal mapping |
| `src/lib/disk-write.ts`, `src/lib/disk-history/restore.ts`, `src/lib/device-write.ts` (modify) | `hd_read_only` refusals |
| `src/app/api/disks/[id]/route.ts`, `volume-name/route.ts`, `files/batch/route.ts`, `files/[block]/route.ts` (modify) | HD refusals |
| `src/components/disks/file-actions.tsx` (modify) | copy for `hd_read_only` |
| `src/components/disks/hd-tag.tsx` (new) | the "HD" tag |
| `src/components/games/disk-row.tsx`, `write-protect-toggle.tsx` (modify) | tag, locked toggle |
| `src/lib/queries.ts`, `src/components/library/game-table.tsx` (modify) | `hasHd`, tag |
| `src/components/ingest/dropzone.tsx` (modify) | tag |
| `src/app/(app)/disks/[id]/files/page.tsx` (modify) | "can't be browsed" |
| `src/lib/live-state.ts`, `src/lib/drive-chips.ts`, `src/components/shell/drive-chips.tsx` (modify) | chip Protect disabled for HD |
| `e2e/hd-disks.spec.ts` (new) | end-to-end web behaviour |
| `wifi-floppy/firmware/src/adf_mfm.{c,h}` (from spike) + `test/test_adf_mfm.c` + `test/fixtures/adf_mfm_hd/*` | the C encoder and its oracle |
| `scripts/adf-mfm-hd-fixtures.py`, `scripts/adf-mfm-real-fixtures.ts` (from spike) | fixture generators |
| `wifi-floppy/firmware/src/psram_image.{c,h}` (modify) | slot kind, track pointer, refusals |
| `wifi-floppy/firmware/src/image_loader.{c,h}` (modify) + `test/test_image_loader_wfad.c` (new) | WFAD parse |
| `wifi-floppy/firmware/src/track_cache.{c,h}` (modify) + `test/test_track_cache_hd.c` (new) | encode on read; `TRACK_BUF_BYTES` |
| `wifi-floppy/firmware/src/write_back.{c,h}` (modify) + `test/test_write_back.c` | read-only verdict, `write_back_wprot` |
| `wifi-floppy/firmware/src/drive_id.{c,h}` (new, from spike, changed) + `test/test_drive_id.c` | the ID model |
| `wifi-floppy/firmware/src/floppy.pio`, `bus_out.{c,h}`, `dskchg.c` (modify) | the responder |
| `wifi-floppy/firmware/src/device_client.{c,h}` (modify) + test | `playsHd` |
| `wifi-floppy/firmware/src/main.c`, `CMakeLists.txt` (modify) | wiring, buffers, heap log, `WF_DRIVE_ID`, 1.4.0 |
| `scripts/hd-test-disk.sh` (new) | bench HD Workbench disk |
| `README.md`, `HANDOFF.md` (modify) | docs, bench checklist |

---

### Task 1: Web — recognise HD, write WFAD, serve it

**Files:**
- Modify: `src/lib/adfmfm/constants.ts` (append after `ENCODER_VERSION`, line 56)
- Create: `src/lib/adfmfm/wfad.ts`, `src/lib/adfmfm/wfad.test.ts`
- Modify: `src/lib/adfmfm/index.ts:16-19` (exports)
- Modify: `src/lib/disk-format.ts` (whole file), `src/lib/disk-format.test.ts`
- Create: `src/lib/disk-format-sql.ts`
- Modify: `src/app/api/device/image/[sha256]/route.ts:6,48-97`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - From `@/lib/adfmfm/constants` (and re-exported by `@/lib/adfmfm`): `HD_SECTORS = 22`, `HD_TRACK_DATA_BYTES = 11264`, `ADF_HD_BYTES = 1802240`, `WFAD_MAGIC = 0x44414657`, `WFAD_VERSION = 1`, `WFAD_HEADER_BYTES = 16`, `WFAD_BYTES = 1802256`.
  - From `@/lib/adfmfm`: `writeWfad(adf: Uint8Array): Uint8Array`, `class WfadFormatError extends AdfmfmError`.
  - From `@/lib/disk-format`: `adfDensity(sizeBytes: number): 'dd' | 'hd' | null`, `isHdAdf(d: { imageFormat: string; sizeBytes: number }): boolean`, `isServable(...)` (now true for HD).
  - From `@/lib/disk-format-sql`: `isHdAdfSql(): SQL`, which renders `("disks"."image_format" = 'adf' and "disks"."size_bytes" = $n)`.

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/sfs/Devel/webadf/.claude/worktrees/hd-floppies
pnpm install
cp /Users/sfs/Devel/webadf/.env.local .env.local   # secrets: never cat, echo or commit it (.gitignore:13 covers it)
git status --short                                 # expect nothing but untracked build output, if any
```

Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` before Step 7.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/adfmfm/wfad.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeWfad, WfadFormatError } from './wfad';
import { ADF_BYTES, ADF_HD_BYTES, WFAD_BYTES } from './constants';

// The header, spelled out byte by byte from the spec's table (HD spec §4.4),
// NOT computed from the constants under test: a wrong constant must fail here.
// wifi-floppy/firmware/test/test_image_loader_wfad.c holds the board's side to
// the same 16 bytes.
const HEADER = [
  0x57, 0x46, 0x41, 0x44,   // "WFAD"
  0x01, 0x00, 0x00, 0x00,   // version 1
  0xa0, 0x00, 0x00, 0x00,   // 160 tracks
  0x16, 0x00, 0x00, 0x00,   // 22 sectors per track
];

// synthetic.ts's xorshift32, over an HD-sized image. Synthetic: no real disk.
function hdAdf(): Uint8Array {
  const adf = new Uint8Array(1_802_240);
  let x = 0x12345678;
  for (let i = 0; i < adf.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    adf[i] = x & 0xff;
  }
  return adf;
}

describe('writeWfad', () => {
  it('is the spec header followed by the ADF, byte for byte', () => {
    const adf = hdAdf();
    const out = writeWfad(adf);
    expect(out.length).toBe(1_802_256);
    expect(WFAD_BYTES).toBe(1_802_256);
    expect(Array.from(out.subarray(0, 16))).toEqual(HEADER);
    expect(Buffer.from(out.subarray(16)).equals(Buffer.from(adf))).toBe(true);
  });

  it('track t starts at 16 + t * 11,264 (track-major, 22 x 512 bytes each)', () => {
    const adf = hdAdf();
    const out = writeWfad(adf);
    for (const t of [0, 1, 80, 159]) {
      expect(out[16 + t * 11_264]).toBe(adf[t * 22 * 512]);
      expect(out[16 + t * 11_264 + 11_263]).toBe(adf[t * 22 * 512 + 11_263]);
    }
  });

  it('throws on anything that is not exactly one HD ADF', () => {
    expect(() => writeWfad(new Uint8Array(ADF_BYTES))).toThrow(WfadFormatError);
    expect(() => writeWfad(new Uint8Array(ADF_HD_BYTES - 1))).toThrow(WfadFormatError);
    expect(() => writeWfad(new Uint8Array(ADF_HD_BYTES + 1))).toThrow(WfadFormatError);
    expect(() => writeWfad(new Uint8Array(0))).toThrow(WfadFormatError);
  });
});
```

Replace `src/lib/disk-format.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { adfDensity, isHdAdf, isHfeFilename, isServable } from './disk-format';

describe('disk-format', () => {
  it('recognises .hfe case-insensitively and nothing else', () => {
    expect(isHfeFilename('Game (1990)(X)[cr].HFE')).toBe(true);
    expect(isHfeFilename('game.hfe')).toBe(true);
    expect(isHfeFilename('game.hfe.adf')).toBe(false);
    expect(isHfeFilename('hfe')).toBe(false);
  });

  it('adfDensity knows exactly two sizes', () => {
    expect(adfDensity(901_120)).toBe('dd');
    expect(adfDensity(1_802_240)).toBe('hd');
    expect(adfDensity(1_802_239)).toBeNull();
    expect(adfDensity(2_049_024)).toBeNull();
    expect(adfDensity(0)).toBeNull();
  });

  it('HD is a property of an ADF row, never of an HFE of the same size', () => {
    expect(isHdAdf({ imageFormat: 'adf', sizeBytes: 1_802_240 })).toBe(true);
    expect(isHdAdf({ imageFormat: 'hfe', sizeBytes: 1_802_240 })).toBe(false);
    expect(isHdAdf({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(false);
  });

  it('an ADF is servable at exactly 901,120 or 1,802,240 bytes; an HFE always (validated at ingest); anything else never', () => {
    expect(isServable({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(true);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 1_802_240 })).toBe(true);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 2_049_024 })).toBe(false);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 900_000 })).toBe(false);
    expect(isServable({ imageFormat: 'hfe', sizeBytes: 2_049_024 })).toBe(true);
    expect(isServable({ imageFormat: 'ipf', sizeBytes: 901_120 })).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run src/lib/adfmfm/wfad.test.ts src/lib/disk-format.test.ts`
Expected: FAIL. `./wfad` cannot be resolved, and `adfDensity` / `isHdAdf` are not exported.

- [ ] **Step 4: Add the constants**

Append to `src/lib/adfmfm/constants.ts`:

```ts

// --- HD (spec 2026-09-26-hd-floppies) ---------------------------------------
// An HD ADF: 22 sectors a track instead of 11, same 160 tracks. The board, not
// the server, encodes these to MFM (a track at a time, on read), so no HD
// TRACK_BITS lives here; the firmware's adf_mfm.h owns 202,688.
export const HD_SECTORS = 22;
export const HD_TRACK_DATA_BYTES = HD_SECTORS * SECTOR_DATA_BYTES; // 11264
export const ADF_HD_BYTES = TRACKS * HD_TRACK_DATA_BYTES;          // 1802240

// WFAD: what GET /api/device/image sends for an HD disk (spec §4.4). A 16-byte
// header, then the ADF itself. image_loader.c parses it (WFAD_* there).
export const WFAD_MAGIC = 0x44414657; // 'WFAD' little-endian
export const WFAD_VERSION = 1;
export const WFAD_HEADER_BYTES = 16;
export const WFAD_BYTES = WFAD_HEADER_BYTES + ADF_HD_BYTES;        // 1802256
```

- [ ] **Step 5: Write the WFAD writer**

Create `src/lib/adfmfm/wfad.ts`:

```ts
import {
  ADF_HD_BYTES, HD_SECTORS, TRACKS, WFAD_BYTES, WFAD_HEADER_BYTES, WFAD_MAGIC, WFAD_VERSION,
} from './constants';
import { AdfmfmError } from './errors';

export class WfadFormatError extends AdfmfmError {
  constructor(message: string) {
    super(message);
    this.name = 'WfadFormatError';
  }
}

/**
 * The container the board loads an HD disk from (HD spec §4.4): a header, then
 * the ADF unchanged. The ADF is already track-major (track = cylinder * 2 +
 * head, 22 x 512 bytes each), which is exactly the order image_loader.c fills
 * PSRAM slots in, so there is nothing to reorder -- only to refuse anything
 * that is not one whole HD image.
 */
export function writeWfad(adf: Uint8Array): Uint8Array {
  if (adf.length !== ADF_HD_BYTES) {
    throw new WfadFormatError(`an HD ADF is ${ADF_HD_BYTES} bytes, got ${adf.length}`);
  }
  const out = new Uint8Array(WFAD_BYTES);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, WFAD_MAGIC, true);
  dv.setUint32(4, WFAD_VERSION, true);
  dv.setUint32(8, TRACKS, true);
  dv.setUint32(12, HD_SECTORS, true);
  out.set(adf, WFAD_HEADER_BYTES);
  return out;
}
```

In `src/lib/adfmfm/index.ts`, after the line `export { WfmfFormatError } from './wfmf';` add:

```ts
export { WfadFormatError, writeWfad } from './wfad';
```

- [ ] **Step 6: Write the density helpers**

Replace `src/lib/disk-format.ts` with:

```ts
// What kind of image a disk row holds. Named "image format", not "kind":
// src/lib/game-kind.ts already means Game/Demo/... by "kind", on the same pages.

// The constants file alone, not '@/lib/adfmfm': client components (the
// dropzone, the drive chips) import this module and must not bundle the
// encoder along with it.
import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm/constants';
import { isHfeName } from '@/lib/blob-upload';

export type { ImageFormat } from '@/db/schema/catalog';

// One rule, shared with both upload clients through blob-upload (which must
// stay import-free for the CLI): the server's too_many_hfe count and the
// clients' batch split have to agree on what an HFE name is.
export const isHfeFilename = isHfeName;

/**
 * THE place that knows what an ADF's size means (HD spec §4.1). An ADF has
 * exactly one of two geometries: 11 sectors a track (DD, 901,120 bytes) or
 * 22 (HD, 1,802,240). Anything else is not a disk the board can play. The
 * SQL twin for WHERE clauses is isHdAdfSql (disk-format-sql.ts).
 */
export function adfDensity(sizeBytes: number): 'dd' | 'hd' | null {
  if (sizeBytes === ADF_BYTES) return 'dd';
  if (sizeBytes === ADF_HD_BYTES) return 'hd';
  return null;
}

/** An HD disk: an ADF row of HD size. An HFE is never "HD" here, whatever its size. */
export function isHdAdf(d: { imageFormat: string; sizeBytes: number }): boolean {
  return d.imageFormat === 'adf' && adfDensity(d.sizeBytes) === 'hd';
}

/**
 * Can the device image route serve this disk? Decided by the row's format
 * and size, never by sniffing the bytes (spec D2). A DD ADF goes out as WFMF
 * (encodeDisk), an HD ADF as WFAD (writeWfad) -- both throw on any other
 * size; an HFE was fully validated at ingest (inspectHfe), and the route
 * re-parses it per request.
 */
export function isServable(d: { imageFormat: string; sizeBytes: number }): boolean {
  if (d.imageFormat === 'adf') return adfDensity(d.sizeBytes) !== null;
  if (d.imageFormat === 'hfe') return true;
  return false;
}
```

Create `src/lib/disk-format-sql.ts`:

```ts
// isHdAdf (disk-format.ts) for statements that must decide HD inside the
// query itself: an UPDATE's WHERE (a refusal that cannot race a concurrent
// write) or a GROUP BY aggregate. Kept out of disk-format.ts so client
// components that import that module never pull in drizzle.
import { sql, type SQL } from 'drizzle-orm';
import { disks } from '@/db/schema/catalog';
import { ADF_HD_BYTES } from '@/lib/adfmfm/constants';

export function isHdAdfSql(): SQL {
  return sql`(${disks.imageFormat} = 'adf' and ${disks.sizeBytes} = ${ADF_HD_BYTES})`;
}
```

- [ ] **Step 7: Serve HD as WFAD**

In `src/app/api/device/image/[sha256]/route.ts`:

Replace `import { encodeDisk } from '@/lib/adfmfm';` with:

```ts
import { encodeDisk, writeWfad } from '@/lib/adfmfm';
import { isHdAdf } from '@/lib/disk-format';
```

Replace the block from `const formats = await getDb()` through `const isHfe = formats.some((r) => r.imageFormat === 'hfe');` with:

```ts
  const formats = await getDb()
    .select({ imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })
    .from(disks)
    .where(and(eq(disks.orgId, device.orgId), eq(disks.sha256, sha256)));
  const isHfe = formats.some((r) => r.imageFormat === 'hfe');
  // HD is a property of the row as well (format + size, isHdAdf), never
  // sniffed from the bytes. An HD disk goes out as WFAD: the ADF itself, which
  // the board encodes a track at a time on read (HD spec §4.4, §5.2).
  const isHd = !isHfe && formats.some(isHdAdf);
```

Replace the `let wfmf: Uint8Array;` … `return new Response(wfmf …` section (through the end of the handler) with:

```ts
  let body: Uint8Array;
  try {
    if (isHfe) {
      const parsed = parseHfe(stored);
      if (!parsed.ok) throw new Error(parsed.reason);
      body = hfeToWfmf(parsed.disk);
    } else if (isHd) {
      body = writeWfad(stored);
    } else {
      body = encodeDisk(stored);
    }
  } catch (e) {
    // A stored blob that will not encode is our bug or a corrupt object, not
    // the device's fault -- but it is also never going to start encoding on a
    // retry. setDesired (src/lib/mount.ts) mounts only what isServable
    // accepts, so this path should be unreachable for a freshly mounted disk;
    // it remains for a disk that became desired before that guard existed.
    // 422, not 500: this is permanent, not transient, and a device must not
    // treat it as a server fault worth retrying.
    return Response.json(
      { error: 'encode_failed', sha256, detail: (e as Error).message },
      { status: 422 },
    );
  }

  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // Computed, never a constant: an HFE's tracks keep their own lengths,
      // and WFAD (1,802,256) is not WFMF (2,027,536).
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    },
  });
}
```

- [ ] **Step 8: Run the tests and the type check**

Run: `pnpm exec vitest run src/lib/adfmfm src/lib/disk-format.test.ts && pnpm exec tsc --noEmit -p . && pnpm lint`
Expected: all vitest PASS. `tsc` prints nothing. `eslint` reports 0 errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/adfmfm/constants.ts src/lib/adfmfm/wfad.ts src/lib/adfmfm/wfad.test.ts src/lib/adfmfm/index.ts \
  src/lib/disk-format.ts src/lib/disk-format.test.ts src/lib/disk-format-sql.ts "src/app/api/device/image/[sha256]/route.ts"
git commit -F- <<'EOF'
hd: recognise HD ADFs and send them to the board as WFAD

adfDensity is the one place that knows 901,120 from 1,802,240; isServable
now accepts HD, and the image route sends an HD disk as WFAD (a 16-byte
header plus the ADF) instead of WFMF. Nothing can mount one yet: setDesired
refuses HD until a board reports playsHd (next commit).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 2: Web — the `playsHd` capability, the mount gate, forced write-protect, NFC

**Files:**
- Modify: `src/db/schema/devices.ts:56` (after `trackMaxBytes`)
- Generate: `drizzle/0026_plays_hd.sql`, `drizzle/meta/0026_snapshot.json`, `drizzle/meta/_journal.json`
- Modify: `src/db/devices-schema.test.ts` (append)
- Modify: `src/app/api/device/status/route.ts:44,115`
- Modify: `src/lib/mount.ts` (imports; `SetDesiredOutcome` :31-36; `setDesired` :48-102; `readDesired` :162-225; `recordStatus` :242-291)
- Create: `src/lib/mount-hd.test.ts`
- Modify: `src/lib/mount-record-status.test.ts` (append)
- Create: `src/lib/hd-messages.ts`
- Modify: `src/app/api/devices/[id]/mount/route.ts:4,33-36`
- Modify: `src/lib/nfc/rules.ts`, `src/lib/nfc/rules.test.ts`, `src/lib/nfc/store.ts:29`

**Interfaces:**
- Consumes: `isHdAdf` (Task 1).
- Produces:
  - `devices.playsHd` (drizzle column `plays_hd`, `boolean`, not null, default false).
  - `recordStatus(deviceId, { …, playsHd?: boolean })`.
  - `SetDesiredOutcome` reason union: `'not_found' | 'track_too_long' | 'hd_unsupported'`.
  - `HD_UNSUPPORTED`, `HD_NOT_BROWSABLE`, `HD_READ_ONLY` from `@/lib/hd-messages`.
  - `tapRefusalOutcome(reason: 'not_found' | 'track_too_long' | 'hd_unsupported'): TapOutcome` from `@/lib/nfc/rules`.
  - Mount route: 409 `{ error: 'hd_unsupported', reason: HD_UNSUPPORTED }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/db/devices-schema.test.ts`:

```ts
describe('devices.playsHd (HD spec §4.3)', () => {
  it('is a non-null boolean defaulting to false, so every existing board reads as unable to play HD', () => {
    expect(devices.playsHd.notNull).toBe(true);
    expect(devices.playsHd.hasDefault).toBe(true);
    expect(devices.playsHd.default).toBe(false);
  });
});
```

Append to `src/lib/mount-record-status.test.ts`:

```ts
// playsHd belongs to the firmware BUILD (the drive-ID responder, WF_DRIVE_ID),
// exactly like trackMaxBytes: a report that names its firmware without it is
// a build that cannot answer HD -- older, built with the responder off, or a
// board that reverted a trial boot -- and must stop being sent HD disks.
describe('recordStatus playsHd', () => {
  it('stores what a board reports', async () => {
    await recordStatus('dev-1', { ...base, playsHd: true });
    expect(patches[0].playsHd).toBe(true);
  });

  it('drops to false when a report names its firmware but says nothing about HD (a rollback)', async () => {
    await recordStatus('dev-1', { ...base });
    expect('playsHd' in patches[0]).toBe(true);
    expect(patches[0].playsHd).toBe(false);
  });

  it('leaves the column alone when a report names no firmware at all', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    expect('playsHd' in patches[0]).toBe(false);
  });
});
```

Create `src/lib/mount-hd.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// setDesired and readDesired against a fake db that answers each query in
// call order and keeps every WHERE, so the HD gate is proven to sit IN the
// UPDATE (rendered back to SQL) -- the same no-read-before-write rule the
// track gate follows -- not merely inferred from the outcome.
let selects: unknown[][] = [];
let updates: unknown[][] = [];
const wheres: unknown[] = [];
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'leftJoin', 'innerJoin', 'set']) c[k] = () => c;
  c.where = (w: unknown) => { wheres.push(w); return c; };
  c.limit = () => Promise.resolve(result);
  c.returning = () => Promise.resolve(result);
  return c;
}
const fakeDb = {
  select: () => chain(selects.shift() ?? []),
  update: () => chain(updates.shift() ?? []),
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { setDesired, readDesired } = await import('./mount');
const render = (w: unknown) => new PgDialect().sqlToQuery(w as SQL).sql;

const HD = {
  id: 'disk-hd', sha256: 'a'.repeat(64), gameId: 'g1', diskNo: 1,
  sizeBytes: 1_802_240, imageFormat: 'adf', maxTrackBits: null,
};
const DD = { ...HD, id: 'disk-dd', sizeBytes: 901_120 };

beforeEach(() => { selects = []; updates = []; wheres.length = 0; });

describe('setDesired and HD (spec §4.3)', () => {
  it('gates an HD disk on plays_hd inside the UPDATE itself', async () => {
    selects = [[HD]];
    updates = [[{ version: 7 }]];
    expect(await setDesired('org-1', 'dev-1', HD.id)).toEqual({ ok: true, version: 7 });
    expect(render(wheres[1])).toContain('"devices"."plays_hd"');
  });

  it('does not gate a DD disk on plays_hd', async () => {
    selects = [[DD]];
    updates = [[{ version: 3 }]];
    expect(await setDesired('org-1', 'dev-1', DD.id)).toEqual({ ok: true, version: 3 });
    expect(render(wheres[1])).not.toContain('plays_hd');
  });

  it("refuses hd_unsupported for this org's board that cannot play HD", async () => {
    selects = [[HD], [{ id: 'dev-1' }]];
    updates = [[]];
    expect(await setDesired('org-1', 'dev-1', HD.id)).toEqual({ ok: false, reason: 'hd_unsupported' });
  });

  it("stays a plain not_found for a device that is not this org's", async () => {
    selects = [[HD], []];
    updates = [[]];
    expect(await setDesired('org-1', 'dev-x', HD.id)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('readDesired and HD (spec §4.3)', () => {
  const row = {
    version: 5, sha256: 'a'.repeat(64), diskId: 'disk-hd', gameId: 'g1', diskNo: 1,
    title: 'T', label: 'L', diskCount: 1,
  };

  it('always sends an HD disk write-protected, whatever the library row says', async () => {
    selects = [[{ ...row, writeProtected: false, imageFormat: 'adf', sizeBytes: 1_802_240 }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(true);
  });

  it("leaves a DD disk's flag as the library has it", async () => {
    selects = [[{ ...row, writeProtected: false, imageFormat: 'adf', sizeBytes: 901_120 }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(false);
  });
});
```

Append to `src/lib/nfc/rules.test.ts` (and add `tapRefusalOutcome` to its import list from `./rules`):

```ts
describe('tapRefusalOutcome', () => {
  it('keeps not_found', () => expect(tapRefusalOutcome('not_found')).toBe('not_found'));
  it('keeps too_long', () => expect(tapRefusalOutcome('track_too_long')).toBe('too_long'));
  // Only pre-1.4.0 boards are ever refused HD, and they turn an outcome word
  // they do not know into "no answer" (device_client.c) -- a silent drop.
  it('says too_long for hd_unsupported, the one refusal old firmware shows', () =>
    expect(tapRefusalOutcome('hd_unsupported')).toBe('too_long'));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/db/devices-schema.test.ts src/lib/mount-record-status.test.ts src/lib/mount-hd.test.ts src/lib/nfc/rules.test.ts`
Expected: FAIL. `devices.playsHd` is undefined, `patches[0].playsHd` is undefined, the `plays_hd` assertions fail, and `tapRefusalOutcome` is not exported.

- [ ] **Step 3: The column and its migration**

In `src/db/schema/devices.ts`, add `boolean` to the `drizzle-orm/pg-core` import and insert after the `trackMaxBytes` line:

```ts

  /**
   * Whether this board's firmware answers the Amiga's drive-ID read as HD for
   * an HD disk (the drive_id PIO responder, WF_DRIVE_ID), as IT reports in
   * every status (HD spec §4.3, §5.5). False for every board before 1.4.0 and
   * for a build with the responder off. setDesired refuses an HD disk
   * anywhere else (hd_unsupported): without the ID the Amiga reads it with DD
   * geometry and fails at the first block where the layouts differ.
   */
  playsHd: boolean('plays_hd').notNull().default(false),
```

Then:

```bash
pnpm db:generate --name plays_hd
cat drizzle/0026_plays_hd.sql
```

Expected: one statement, `ALTER TABLE "devices" ADD COLUMN "plays_hd" boolean DEFAULT false NOT NULL;`. Edit that file so it reads exactly:

```sql
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "plays_hd" boolean DEFAULT false NOT NULL;
```

(The guarded form is the repo convention; see `drizzle/0025_nfc_tap.sql`.) `git status --short drizzle/` must show exactly the three files named under **Files** above.

- [ ] **Step 4: The status route and `recordStatus`**

In `src/app/api/device/status/route.ts`, after the `trackMaxBytes:` schema line (line 44) add:

```ts
  // HD spec §5.5: the drive-ID responder is built in. Only ever sent as true;
  // absent means "cannot play HD" (see recordStatus). Dropped, not rejected,
  // when malformed -- the telemetry rule above.
  playsHd: z.boolean().optional().catch(undefined),
```

and after `trackMaxBytes: parsed.data.trackMaxBytes,` in the `recordStatus` call add `playsHd: parsed.data.playsHd,`.

In `src/lib/mount.ts`, in `recordStatus`'s parameter type after the `trackMaxBytes?: number;` member add:

```ts
    /** The drive-ID responder is built in (HD spec §5.5). Absent from builds before 1.4.0. */
    playsHd?: boolean;
```

and after the `else if (s.firmwareVersion !== undefined) patch.trackMaxBytes = null;` line add:

```ts
  // The same build-bound rule as trackMaxBytes: a report that names its
  // firmware but says nothing about HD comes from a build without the
  // responder (older, WF_DRIVE_ID=OFF, or a reverted trial boot), and must
  // stop being sent HD disks.
  if (s.playsHd !== undefined) patch.playsHd = s.playsHd;
  else if (s.firmwareVersion !== undefined) patch.playsHd = false;
```

- [ ] **Step 5: The mount gate and forced write-protect**

In `src/lib/mount.ts`, change the import `import { isServable } from '@/lib/disk-format';` to `import { isHdAdf, isServable } from '@/lib/disk-format';`.

Replace the `SetDesiredOutcome` type with:

```ts
export type SetDesiredOutcome =
  | { ok: true; version: number }
  // not_found covers an unknown device, an unknown or unservable disk, and
  // either belonging to another org -- deliberately indistinguishable.
  // track_too_long and hd_unsupported are only ever reported for a device
  // AND disk this org owns.
  | { ok: false; reason: 'not_found' | 'track_too_long' | 'hd_unsupported' };
```

In `setDesired`, replace everything from `const fits = disk.maxTrackBits === null` to the end of the function with:

```ts
  const fits = disk.maxTrackBits === null
    ? sql`true`
    : sql`coalesce(${devices.trackMaxBytes}, ${LEGACY_BOARD_TRACK_MAX_BYTES}) * 8 >= ${disk.maxTrackBits}`;
  // An HD disk goes only to a board whose firmware answers the drive-ID read
  // as HD (HD spec §4.3); anywhere else the Amiga reads it with DD geometry.
  // In the UPDATE's WHERE, like `fits`, so a status report landing between a
  // read and the write cannot slip past.
  const hd = isHdAdf(disk);
  const playsHd = hd ? eq(devices.playsHd, true) : sql`true`;

  // The version bump is in the same UPDATE as the state it describes, so a
  // poller can never observe a new version beside the old disk, or the reverse.
  const updated = await db.update(devices)
    .set({
      desiredSha256: disk.sha256,
      desiredGameId: disk.gameId,
      desiredDiskNo: disk.diskNo,
      desiredDiskId: disk.id,
      desiredSetAt: new Date(),
      desiredVersion: sql`${devices.desiredVersion} + 1`,
    })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId), fits, playsHd))
    .returning({ version: devices.desiredVersion });

  if (updated[0]) return { ok: true, version: updated[0].version };
  if (disk.maxTrackBits === null && !hd) return { ok: false, reason: 'not_found' };
  // Nothing updated: tell a board of this org that is too old apart from a
  // device that is not this org's at all (still 404 for the latter).
  const owned = await db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (owned.length === 0) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: hd ? 'hd_unsupported' : 'track_too_long' };
}
```

Also update `setDesired`'s doc comment: after "…exceeds what the board's firmware holds" add "; hd_unsupported when the disk is HD and the board has not reported playsHd".

In `readDesired`'s select, after `writeProtected: disks.writeProtected,` add:

```ts
      imageFormat: disks.imageFormat,
      sizeBytes: disks.sizeBytes,
```

and replace the `writeProtected: r.writeProtected ?? true,` line with:

```ts
      // A disk row that has gone missing is not a licence to allow writes.
      // And HD is read-only on the Amiga in this release (HD spec §4.3): the
      // board never gets a writable HD disk, whatever the row says.
      writeProtected: (r.writeProtected ?? true) ||
        (r.imageFormat !== null && r.sizeBytes !== null &&
          isHdAdf({ imageFormat: r.imageFormat, sizeBytes: r.sizeBytes })),
```

(Delete the old one-line "A disk row that has gone missing…" comment above it; the new block carries it.)

- [ ] **Step 6: Messages, the mount route, NFC**

Create `src/lib/hd-messages.ts`:

```ts
// Every sentence a person reads about an HD disk (HD spec §4.2, §4.3, §6).
// The first two are the spec's words verbatim; tests compare against these
// constants, so copy changes happen here.

export const HD_UNSUPPORTED = "Update the drive's firmware to play HD disks";

export const HD_NOT_BROWSABLE = "HD disks can't be browsed in the browser yet";

export const HD_READ_ONLY =
  'HD disks are read-only for now: the Amiga can load from them but not save to them.';
```

In `src/app/api/devices/[id]/mount/route.ts` add `import { HD_UNSUPPORTED } from '@/lib/hd-messages';` and, directly before the `track_too_long` line (line 36), insert:

```ts
  // HD spec §4.3: the disk is HD and this board's firmware cannot answer the
  // Amiga's drive-ID read as HD. Said, not hidden; the fix is an update.
  if (!result.ok && result.reason === 'hd_unsupported') {
    return Response.json({ error: 'hd_unsupported', reason: HD_UNSUPPORTED }, { status: 409 });
  }
```

Append to `src/lib/nfc/rules.ts`:

```ts

/**
 * The tap outcome for a mount setDesired refused. hd_unsupported goes out as
 * 'too_long': the only boards ever refused an HD disk run firmware older than
 * 1.4.0 (or built with WF_DRIVE_ID off), and device_client.c turns an outcome
 * word it does not know into "no answer" -- the silent drop HD spec §4.3
 * forbids. 'too_long' is a refusal those builds show ("Tag: tracks too
 * long"), and its remedy is the same one: update the board's firmware.
 */
export function tapRefusalOutcome(
  reason: 'not_found' | 'track_too_long' | 'hd_unsupported',
): TapOutcome {
  return reason === 'not_found' ? 'not_found' : 'too_long';
}
```

In `src/lib/nfc/store.ts`, change the import to `import { decideTap, NFC_WRITE_TTL_MS, shouldStoreWriteResult, tapRefusalOutcome, type TapOutcome } from '@/lib/nfc/rules';` and line 29 to:

```ts
    outcome = r.ok ? 'mounting' : tapRefusalOutcome(r.reason);
```

- [ ] **Step 7: Run the tests and the type check**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit -p . && pnpm lint`
Expected: the whole vitest suite PASSES (1164+ tests), with 0 type errors and 0 lint errors.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema/devices.ts drizzle/0026_plays_hd.sql drizzle/meta/0026_snapshot.json drizzle/meta/_journal.json \
  src/db/devices-schema.test.ts src/app/api/device/status/route.ts src/lib/mount.ts src/lib/mount-hd.test.ts \
  src/lib/mount-record-status.test.ts src/lib/hd-messages.ts "src/app/api/devices/[id]/mount/route.ts" \
  src/lib/nfc/rules.ts src/lib/nfc/rules.test.ts src/lib/nfc/store.ts
git commit -F- <<'EOF'
hd: devices.plays_hd; HD mounts only on a board that reports it; HD always write-protected

Generated via pnpm db:generate --name plays_hd, hand-edited to the guarded
ADD COLUMN IF NOT EXISTS form. NOT applied to the database.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

- [ ] **Step 9: Hand the migration to the controller, and stop**

Report to the controller, verbatim: "Migration `drizzle/0026_plays_hd.sql` must be applied to the live database before any e2e run or deploy: `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "plays_hd" boolean DEFAULT false NOT NULL;`. Until it is, every query that selects the whole `devices` row fails." Do not start Task 4's e2e step until the controller confirms. Tasks 3, 5–10 need no database and may proceed.

---

### Task 3: Web — every write path refuses HD by name

**Files:**
- Modify: `src/lib/disk-write.ts:63-81`, `src/lib/disk-write.test.ts` (append a case)
- Modify: `src/lib/disk-history/restore.ts:46-66`
- Modify: `src/app/api/disks/[id]/volume-name/route.ts:59-74`
- Modify: `src/app/api/disks/[id]/route.ts:1-43` (PATCH)
- Modify: `src/app/api/disks/[id]/files/batch/route.ts:128-140`
- Modify: `src/app/api/disks/[id]/files/[block]/route.ts:69-80` (GET)
- Modify: `src/lib/device-write.ts:19-27,80-83`
- Modify: `src/components/disks/file-actions.tsx:9,56`

**Interfaces:**
- Consumes: `isHdAdf` (Task 1), `isHdAdfSql()` (Task 1), `HD_READ_ONLY` (Task 2).
- Produces (all verified by Task 4's e2e):
  - `applyDiskEdit` → `{ ok: false, status: 409, reason: 'hd_read_only' }`, which reaches clients as `{ error: 'edit_failed', reason: 'hd_read_only' }`.
  - `restoreVersion` → the same outcome; the route answers `{ error: 'hd_read_only' }`.
  - `PATCH /api/disks/[id]` `{ writeProtected: false }` → 409 `{ error: 'hd_read_only' }`. `{ writeProtected: true }` still succeeds.
  - `PATCH …/volume-name`, `POST …/files/batch` → 409 `{ error: 'hd_read_only' }`.
  - `GET …/files/[block]` → 409 `{ error: 'hd_not_browsable' }`.
  - `stageTrack` (board) → 409 `{ error: 'write_protected', reason: 'hd_read_only' }`.

- [ ] **Step 1: Write the failing test**

Append inside `describe('applyDiskEdit', …)` in `src/lib/disk-write.test.ts`:

```ts
  it('refuses an HD disk by name before reading a byte (HD spec §4.2)', async () => {
    selectResults = [[{ ...DISK_ROW, imageFormat: 'adf', sizeBytes: 1_802_240 }]];
    const edit = vi.fn();
    const { applyDiskEdit } = await import('@/lib/disk-write');

    const result = await applyDiskEdit(ORG_ID, DISK_ID, edit);

    expect(result).toEqual({ ok: false, status: 409, reason: 'hd_read_only' });
    expect(edit).not.toHaveBeenCalled();
    expect(diskStoreRead).not.toHaveBeenCalled();
    expect(recordVersion).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/lib/disk-write.test.ts`
Expected: FAIL. The new case gets a holder lookup (`selectResults` is empty, so the disk is not held) followed by a read, instead of `hd_read_only`.

- [ ] **Step 3: The shared-helper refusals**

`src/lib/disk-write.ts`: add `import { isHdAdf } from '@/lib/disk-format';`. In the select, after `imageFormat: disks.imageFormat,` add `sizeBytes: disks.sizeBytes,`. After the HFE refusal line (`if (disk.imageFormat === 'hfe') …`) insert:

```ts
  // HD spec §4.2: no browser editing of an HD disk in this release (adffs
  // reads one geometry). Refused by name before anything is read, rather than
  // left to fail as "no filesystem" further down.
  if (isHdAdf(disk)) return { ok: false, status: 409, reason: 'hd_read_only' };
```

`src/lib/disk-history/restore.ts`: add `import { isHdAdf } from '@/lib/disk-format';`. In its select, after `imageFormat: disks.imageFormat,` add `sizeBytes: disks.sizeBytes,`. After its HFE refusal (line 66) insert:

```ts
  // HD spec §4.2: an HD disk has no browser history in this release, and a
  // restore is an edit. Refused by name, like HFE.
  if (isHdAdf(disk)) return { ok: false, status: 409, reason: 'hd_read_only' };
```

- [ ] **Step 4: The route refusals**

`src/app/api/disks/[id]/volume-name/route.ts`: add `import { isHdAdf } from '@/lib/disk-format';`. Change the select to `.select({ sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })`. After the `hfe_read_only` block (ends line 74) insert:

```ts
  // HD spec §4.2: a rename rewrites the volume through adffs, which reads
  // one geometry today.
  if (isHdAdf(disk)) {
    return Response.json({ error: 'hd_read_only' }, { status: 409 });
  }
```

`src/app/api/disks/[id]/route.ts` (PATCH): change the drizzle import to `import { and, eq, ne, not, sql } from 'drizzle-orm';` and add:

```ts
import { isHdAdf } from '@/lib/disk-format';
import { isHdAdfSql } from '@/lib/disk-format-sql';
```

Replace from the comment `// An HFE is always write-protected (spec D2).` through the end of the `if (updated.length === 0) { … }` block with:

```ts
  // An HFE is always write-protected (spec D2), and so is an HD disk (HD spec
  // §4.3: read-only on the Amiga in this release). Refused here, not only
  // hidden in the UI: a direct call must not be able to make one writable.
  // The format is a condition of the UPDATE itself, not a SELECT before it:
  // a concurrent /complete can flip this row to 'hfe' between the two.
  // Org-scoped in the statement, not in a WHERE a later edit could drop.
  const scope = and(eq(disks.id, id), eq(disks.orgId, orgId));
  const updated = await getDb().update(disks)
    .set({ writeProtected: parsed.data.writeProtected })
    .where(parsed.data.writeProtected
      ? scope
      : and(scope, ne(disks.imageFormat, 'hfe'), not(isHdAdfSql())))
    .returning({ id: disks.id, writeProtected: disks.writeProtected });

  if (updated.length === 0) {
    // Nothing updated: no such disk in this org, or an HFE/HD refused.
    const row = await getDb().select({ imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })
      .from(disks).where(scope).limit(1);
    if (row[0]?.imageFormat === 'hfe') return Response.json({ error: 'hfe_read_only' }, { status: 409 });
    if (row[0] && isHdAdf(row[0])) return Response.json({ error: 'hd_read_only' }, { status: 409 });
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
```

`src/app/api/disks/[id]/files/batch/route.ts`: add `import { isHdAdf } from '@/lib/disk-format';`. Change the entitlement select to `.select({ sha256: disks.sha256, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })`. After `if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });` insert:

```ts
  // HD spec §4.2: refused by name BEFORE the 1.8 MB read, not reported as
  // "no filesystem" by the adffs read below.
  if (isHdAdf(disk)) return Response.json({ error: 'hd_read_only' }, { status: 409 });
```

`src/app/api/disks/[id]/files/[block]/route.ts` (the GET handler): add `import { isHdAdf } from '@/lib/disk-format';`. Change the GET's select (line 70-71) to `.select({ sha256: disks.sha256, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })`. After the GET's `if (!disk) return …404` insert:

```ts
  // HD spec §4.2: "HD disks can't be browsed in the browser yet" -- said as
  // its own reason, not as a missing filesystem.
  if (isHdAdf(disk)) return Response.json({ error: 'hd_not_browsable' }, { status: 409 });
```

(The PATCH and DELETE handlers in the same file go through `applyDiskEdit`, which Step 3 already covers.)

- [ ] **Step 5: The board-facing refusal and the UI copy**

`src/lib/device-write.ts`: add `import { isHdAdf } from '@/lib/disk-format';`. In `stageTrack`, change the disk select to `.select({ wp: disks.writeProtected, sha256: disks.sha256, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })`, and after `if (!disk) return { status: 404, body: { error: 'not_found' } };` insert:

```ts
  // HD spec §4.3: read-only on the Amiga in this release. The board asserts
  // WPROT and discards any capture itself; this is the server's half, and it
  // holds for an already-open session too. `error` stays write_protected --
  // the one refusal uploader.c acts on (it parks and forces WPROT); any other
  // word it treats as transient and retries forever.
  if (isHdAdf(disk)) return { status: 409, body: { error: 'write_protected', reason: 'hd_read_only' } };
```

In the `Outcome` doc comment near the top, change `| 409 write_protected (these two only when opening a session)` to `| 409 write_protected (with an open session only for an HD disk, as { write_protected, reason: 'hd_read_only' }; otherwise only when opening one)`.

`src/components/disks/file-actions.tsx`: add `import { HD_READ_ONLY } from '@/lib/hd-messages';` next to the `HFE_READ_ONLY` import, and after `case 'hfe_read_only': return HFE_READ_ONLY;` add:

```ts
    case 'hd_read_only': return HD_READ_ONLY;
```

- [ ] **Step 6: Run the tests and the type check**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit -p . && pnpm lint`
Expected: all PASS, including the new `applyDiskEdit` case; 0 type and 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/disk-write.ts src/lib/disk-write.test.ts src/lib/disk-history/restore.ts \
  "src/app/api/disks/[id]/volume-name/route.ts" "src/app/api/disks/[id]/route.ts" \
  "src/app/api/disks/[id]/files/batch/route.ts" "src/app/api/disks/[id]/files/[block]/route.ts" \
  src/lib/device-write.ts src/components/disks/file-actions.tsx
git commit -F- <<'EOF'
hd: every write path refuses an HD disk by name (hd_read_only), before reading a byte

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 4: Web — the HD tag, the locked toggle, the file browser message, and the e2e

**Files:**
- Create: `src/components/disks/hd-tag.tsx`
- Modify: `src/components/games/disk-row.tsx`, `src/components/games/write-protect-toggle.tsx`
- Modify: `src/lib/queries.ts:15-51` (`GameListItem`), `:84-92`, `:109-117`, `:136-144` (the three `listGames` selects)
- Modify: `src/components/library/game-table.tsx:10,62`
- Modify: `src/components/ingest/dropzone.tsx:12,486-488`
- Modify: `src/app/(app)/disks/[id]/files/page.tsx:102-117,144,173-180,341-369`
- Modify: `src/lib/live-state.ts:51,105,159`, `src/lib/live-state.test.ts`
- Modify: `src/lib/drive-chips.ts:36,87`, `src/lib/drive-chips.test.ts`, `src/components/shell/drive-chips.tsx:254,312`
- Create: `e2e/hd-disks.spec.ts`

**Interfaces:**
- Consumes: `adfDensity`, `isHdAdf` (Task 1); `isHdAdfSql()` (Task 1); `HD_READ_ONLY`, `HD_NOT_BROWSABLE`, `HD_UNSUPPORTED` (Task 2); every refusal from Task 3.
- Produces:
  - `HdTag({ testId?: string })`.
  - `GameListItem.hasHd: boolean`.
  - `LiveStateRow.mountedSizeBytes: number | null`.
  - `DriveChipDisk.readOnly: 'HFE' | 'HD' | null` (it was `boolean`).
  - `WriteProtectToggle` prop `locked?: string`.
  - Test ids: `hd-tag-<diskId>`, `game-hd-tag`, `ingest-hd-tag`, `hd-not-browsable`, `wp-<diskId>[data-locked]`.

Read `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` before Step 5.

- [ ] **Step 1: Write the failing unit tests**

In `src/lib/drive-chips.test.ts`, add `mountedSizeBytes: 901_120,` to the `loaded` row (after `mountedImageFormat: 'adf',`) and `mountedSizeBytes: null,` to the `empty` row (after `mountedImageFormat: null,`). Add after the HFE case:

```ts
  it('an HD disk reads WP, says why, and cannot be toggled (HD spec §4.3)', () => {
    const c = chip({ ...loaded, mountedSizeBytes: 1_802_240, mountedDiskWriteProtected: false });
    expect(c.disk?.readOnly).toBe('HD');
    expect(protectTag(c)).toBe('WP');
    expect(c.canToggleProtect).toBe(false);
  });

  it('an HFE says HFE', () => {
    expect(chip({ ...loaded, mountedImageFormat: 'hfe' }).disk?.readOnly).toBe('HFE');
    expect(chip(loaded).disk?.readOnly).toBeNull();
  });
```

In `src/lib/live-state.test.ts`, add `mountedSizeBytes: 901_120,` to `base` after `mountedImageFormat: 'adf',`, and add to the `it.each` list after the image-format row:

```ts
    ['the mounted disk\'s size (DD or HD)', { mountedSizeBytes: 1_802_240 }],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/lib/drive-chips.test.ts src/lib/live-state.test.ts`
Expected: FAIL. `tsc`-level errors in vitest (unknown property `mountedSizeBytes`), `readOnly` is `false` rather than `'HD'`, and the fingerprint does not move.

- [ ] **Step 3: Live state and the chips**

`src/lib/live-state.ts`: in `LiveStateRow`, after `mountedImageFormat: string | null;` add:

```ts
  /** With mountedImageFormat, whether the mounted disk is HD (read-only, HD spec §4.3). */
  mountedSizeBytes: number | null;
```

In the fingerprint line list, change `r.mountedDiskCount ?? '', r.mountedImageFormat ?? '', r.desiredGameTitle ?? '',` to `r.mountedDiskCount ?? '', r.mountedImageFormat ?? '', r.mountedSizeBytes ?? '', r.desiredGameTitle ?? '',`. In the select, after `mountedImageFormat: mountedDisk.imageFormat,` add `mountedSizeBytes: mountedDisk.sizeBytes,`.

`src/lib/drive-chips.ts`: add `import { adfDensity } from '@/lib/disk-format';`. Replace the `readOnly` member of `DriveChipDisk` with:

```ts
  /**
   * Why this disk can never be made writable, or null: an HFE (spec D2) or an
   * HD disk (HD spec §4.3). The PATCH refuses to unprotect either.
   */
  readOnly: 'HFE' | 'HD' | null;
```

and replace `readOnly: r.mountedImageFormat === 'hfe',` with:

```ts
          readOnly: r.mountedImageFormat === 'hfe' ? 'HFE'
            : r.mountedImageFormat === 'adf' && r.mountedSizeBytes !== null &&
              adfDensity(r.mountedSizeBytes) === 'hd' ? 'HD'
            : null,
```

`canToggleProtect` (`!disk.readOnly`) and `protectTag` (`c.disk.readOnly || …`) keep working, because `null` is falsy and both tags are truthy.

`src/components/shell/drive-chips.tsx`: change `: disk.readOnly ? 'Disk is read-only (HFE)'` to ``: disk.readOnly ? `Disk is read-only (${disk.readOnly})` ``, and change `? String(disk.readOnly || disk.writeProtected) : undefined}` to `? String(disk.readOnly !== null || disk.writeProtected) : undefined}`.

- [ ] **Step 4: The tag, the row, the toggle, the table, the dropzone**

Create `src/components/disks/hd-tag.tsx`:

```tsx
/**
 * "HD" beside a disk's size (HD spec §4.2): on the game page's disk rows, the
 * library table and the upload list. One component, so the three read alike.
 * No hooks, so server and client components can both render it.
 */
export function HdTag({ testId }: { testId?: string }) {
  return (
    <span className="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide"
          style={{ border: '1px solid var(--hairline-strong)', color: 'var(--ink)' }}
          data-testid={testId}>HD</span>
  );
}
```

`src/components/games/write-protect-toggle.tsx`: replace the component with:

```tsx
export function WriteProtectToggle({ diskId, writeProtected, locked }: {
  diskId: string; writeProtected: boolean;
  /**
   * Why this disk can never be made writable (HD spec §4.3), shown as the
   * tooltip. Present means the toggle is disabled and reads Protected --
   * stated, not hidden, so "read-only" is a visible value.
   */
  locked?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const shownProtected = writeProtected || locked !== undefined;

  async function onToggle() {
    setBusy(true);
    try {
      if (await requestWriteProtect(diskId, !writeProtected)) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onToggle} disabled={busy || locked !== undefined}
            data-testid={`wp-${diskId}`} data-protected={shownProtected ? 'true' : 'false'}
            data-locked={locked !== undefined ? 'true' : undefined}
            aria-pressed={shownProtected}
            title={locked ?? (writeProtected
              ? 'Write protected — the device will refuse writes'
              : 'Writable — the device may write to this disk once write-back ships')}
            className="rounded-md border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide disabled:opacity-50"
            style={shownProtected
              // --hairline is 8% and read as no border at all, which made this
              // toggle look like a status chip rather than the control it is --
              // the clearest instance of the operator's "hard to distinguish
              // labels and buttons". --hairline-strong (14%) is still quiet
              // enough not to compete with the actions beside it.
              ? { borderColor: 'var(--hairline-strong)', color: 'var(--muted)' }
              : { borderColor: 'var(--amber-text)', color: 'var(--amber-text)' }}>
      {shownProtected ? 'Protected' : 'Writable'}
    </button>
  );
}
```

`src/components/games/disk-row.tsx`: add the imports

```tsx
import { HdTag } from '@/components/disks/hd-tag';
import { isHdAdf } from '@/lib/disk-format';
import { HD_READ_ONLY } from '@/lib/hd-messages';
```

After `const isHfe = disk.imageFormat === 'hfe';` add `const isHd = isHdAdf(disk);`. Replace the size span

```tsx
        <span className="truncate font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
          {(disk.sizeBytes / 1024).toFixed(0)} KB · {disk.sha256.slice(0, 12)}
        </span>
```

with

```tsx
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
          {(disk.sizeBytes / 1024).toFixed(0)} KB
          {isHd && <HdTag testId={`hd-tag-${disk.id}`} />}
          <span>· {disk.sha256.slice(0, 12)}</span>
        </span>
```

and replace `<WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected} />` with

```tsx
          <WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected}
                              locked={isHd ? HD_READ_ONLY : undefined} />
```

`src/lib/queries.ts`: add `import { isHdAdfSql } from '@/lib/disk-format-sql';`. In `GameListItem`, change `sizeBytes: number; sha256Prefix: string | null;` to:

```ts
  sizeBytes: number; sha256Prefix: string | null;
  /** Any of its disks is HD (HD spec §4.2): the table tags the size. */
  hasHd: boolean;
```

In each of the three `listGames` selects, after the `sizeBytes: sql<number>…` line add:

```ts
        hasHd: sql<boolean>`coalesce(bool_or(${isHdAdfSql()}), false)`,
```

(Indent it to match the surrounding lines: the third select has two fewer spaces.)

`src/components/library/game-table.tsx`: add `import { HdTag } from '@/components/disks/hd-tag';`. Widen the SIZE track so "1.72 MB HD" fits: change `const COLS = 'grid-cols-[30px_1fr_104px_50px_128px_40px_74px_100px]';` to `const COLS = 'grid-cols-[30px_1fr_104px_50px_128px_40px_96px_100px]';` and both `min-w-[600px]` to `min-w-[622px]`. Replace the size cell with:

```tsx
            <span className="flex items-center justify-end gap-1 text-right" style={{ color: 'var(--muted-2)' }}>
              {fmtSize(g.sizeBytes)}{g.hasHd && <HdTag testId="game-hd-tag" />}
            </span>
```

`src/components/ingest/dropzone.tsx`: change `import { isHfeFilename } from '@/lib/disk-format';` to `import { adfDensity, isHfeFilename } from '@/lib/disk-format';`, add `import { HdTag } from '@/components/disks/hd-tag';`, and replace the size cell

```tsx
                  <span className="text-right" style={{ color: 'var(--muted-2)' }}>
                    {Math.round(r.sizeBytes / 1024)} KB
                  </span>
```

with

```tsx
                  <span className="flex items-center justify-end gap-1 text-right" style={{ color: 'var(--muted-2)' }}>
                    {Math.round(r.sizeBytes / 1024)} KB
                    {!isHfeFilename(r.filename) && adfDensity(r.sizeBytes) === 'hd' && <HdTag testId="ingest-hd-tag" />}
                  </span>
```

- [ ] **Step 5: The file browser**

In `src/app/(app)/disks/[id]/files/page.tsx`: add

```tsx
import { isHdAdf } from '@/lib/disk-format';
import { HD_NOT_BROWSABLE } from '@/lib/hd-messages';
```

In the select, after `imageFormat: disks.imageFormat,` add `sizeBytes: disks.sizeBytes,`. After the HFE `redirect(...)` line add:

```tsx
  // HD spec §4.2: adffs reads one geometry today, so an HD disk has nothing
  // this page can show or edit. Said plainly, in place of adffs's "not a
  // standard 880 KB ADF", which reads as a broken disk. Its 1.8 MB are not
  // even read.
  const hd = isHdAdf(disk);
```

Change `let bytes: Uint8Array | null = null;` and the `try { bytes = … } catch { bytes = null; }` that follows it so that the read is skipped for HD:

```tsx
  let bytes: Uint8Array | null = null;
  if (!hd) {
    try {
      bytes = historicalSeq !== null && historyEntries
        ? await materialise(historyEntries, historicalSeq, (sha256) => diskStore.read(sha256))
        : await diskStore.read(disk.sha256);
    } catch {
      bytes = null;
    }
  }
```

In the JSX, change `{volume === null ? (` to:

```tsx
        {hd ? (
          <div className="glass-card p-5 text-[13px]" style={{ color: 'var(--muted)' }}
               data-testid="hd-not-browsable">
            {HD_NOT_BROWSABLE}
          </div>
        ) : volume === null ? (
```

- [ ] **Step 6: Run the unit tests, type check, lint and build**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit -p . && pnpm lint && pnpm build`
Expected: all PASS and the build completes. If `tsc` names another `LiveStateRow` literal missing `mountedSizeBytes`, or a `GameListItem` literal missing `hasHd`, add the field there (`mountedSizeBytes: null`, `hasHd: false`), and name those files in the commit.

- [ ] **Step 7: Write the e2e spec**

Create `e2e/hd-disks.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded, pairDevice, authHeader } from './device-helpers';

test.afterAll(cleanupSeeded);

const HD_BYTES = 1_802_240;
const UNSUPPORTED = "Update the drive's firmware to play HD disks";
const fakeSha = () => createHash('sha256').update(randomUUID()).digest('hex');

// A synthetic HD ADF: the same bytes every run, so the blob store dedupes it.
// Never a real disk (adfmfm spec §14).
function hdAdf(): Buffer {
  const b = Buffer.alloc(HD_BYTES);
  let x = 0x0badf00d;
  for (let i = 0; i < b.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

// The CLI's path: check, presign, PUT, complete. Same as hfe-disks.spec.ts.
async function uploadViaApi(page: Page, bytes: Buffer, filename: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const check = await page.request.post('/api/ingest/check', { data: { hashes: [sha256] } });
  if (!(await check.json()).known.includes(sha256)) {
    const { uploads } = await (await page.request.post('/api/ingest/presign', {
      data: { files: [{ sha256, sizeBytes: bytes.length }] },
    })).json();
    const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(bytes) });
    expect(put.ok || put.status === 400).toBe(true); // 400: already stored by an earlier run
  }
  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: bytes.length, filename }] },
  });
  expect(res.status()).toBe(200);
  return sha256;
}

test('an uploaded HD ADF is tagged HD everywhere its size shows, cannot be made writable, and the file browser says why', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: 'HD Test (1994)(Webadf).adf', mimeType: 'application/octet-stream', buffer: hdAdf(),
  });
  await expect(page.getByTestId('ingest-row').first().getByTestId('ingest-hd-tag')).toBeVisible();
  await expect.poll(() => getDb().select({ id: disks.id }).from(disks).where(eq(disks.orgId, orgId)),
    { timeout: 30_000 }).toHaveLength(1);
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId, size: disks.sizeBytes, f: disks.imageFormat })
    .from(disks).where(eq(disks.orgId, orgId));
  expect(d).toMatchObject({ size: HD_BYTES, f: 'adf' });

  await page.goto(`/games/${d.gameId}`);
  await expect(page.getByTestId(`hd-tag-${d.id}`)).toBeVisible();
  const wp = page.getByTestId(`wp-${d.id}`);
  await expect(wp).toBeDisabled();
  await expect(wp).toHaveAttribute('data-protected', 'true');
  await expect(wp).toHaveAttribute('data-locked', 'true');

  await page.goto('/library?view=table');
  await expect(page.getByTestId('game-hd-tag')).toBeVisible();

  await page.goto(`/disks/${d.id}/files`);
  await expect(page.getByTestId('hd-not-browsable')).toHaveText("HD disks can't be browsed in the browser yet");
});

test('an HD disk mounts only on a board reporting playsHd, always goes write-protected, and is served as WFAD', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const sha256 = await uploadViaApi(page, hdAdf(), 'HD Mount (1994)(Webadf).adf');
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks).where(eq(disks.orgId, orgId));
  // A writable row -- which the PATCH would refuse -- set directly: the board
  // must be sent write-protect anyway (spec §4.3).
  await getDb().update(disks).set({ writeProtected: false }).where(eq(disks.id, d.id));

  const report = (extra: Record<string, unknown>) => request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, ...extra },
  });
  const mount = () => page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: d.id } });

  // A board that has never reported playsHd: refused, and said why -- in the
  // API and in the game page's mount toast.
  let res = await mount();
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'hd_unsupported', reason: UNSUPPORTED });
  await page.goto(`/games/${d.gameId}`);
  await page.getByTestId(`mount-${d.id}`).click();
  await expect(page.getByText(UNSUPPORTED)).toBeVisible();

  // It reports the capability: accepted.
  expect((await report({ firmwareVersion: '9.9.9+e2e', playsHd: true })).status()).toBe(204);
  res = await mount();
  expect(res.status()).toBe(200);

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.desired).toMatchObject({ sha256, diskId: d.id, writeProtected: true });

  const img = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(img.status()).toBe(200);
  const body = await img.body();
  expect(img.headers()['content-length']).toBe('1802256');
  expect(body.length).toBe(1_802_256);
  // The spec's header table, byte for byte: WFAD, 1, 160, 22.
  expect([...body.subarray(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x16, 0, 0, 0]);
  expect(body.subarray(16).equals(hdAdf())).toBe(true);

  // A rollback to a build without the responder: refused again.
  expect((await report({ firmwareVersion: '9.9.8+e2e' })).status()).toBe(204);
  res = await mount();
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('hd_unsupported');
});

test('every write path refuses an HD disk by name, before reading a byte', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  // A digest with no blob behind it: a route that tried to read the bytes would answer 503, not 409.
  const { diskId } = await seedDisk(orgId, { title: 'HD RO', diskNo: 1, sha256: fakeSha(), sizeBytes: HD_BYTES });

  const off = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } });
  expect(off.status()).toBe(409);
  expect((await off.json()).error).toBe('hd_read_only');
  expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: true } })).status()).toBe(200);

  const mkdir = await page.request.post(`/api/disks/${diskId}/files`, { multipart: { parentBlock: '1760', name: 'x' } });
  expect(mkdir.status()).toBe(409);
  expect(await mkdir.json()).toMatchObject({ error: 'edit_failed', reason: 'hd_read_only' });

  const rename = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'X' } });
  expect(rename.status()).toBe(409);
  expect((await rename.json()).error).toBe('hd_read_only');

  const restore = await page.request.post(`/api/disks/${diskId}/restore`, { data: { seq: 0 } });
  expect(restore.status()).toBe(409);
  expect((await restore.json()).error).toBe('hd_read_only');

  const file = await page.request.get(`/api/disks/${diskId}/files/1760`);
  expect(file.status()).toBe(409);
  expect((await file.json()).error).toBe('hd_not_browsable');
});

test('the board is refused a write to an HD disk, in the words its uploader acts on', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const sha256 = fakeSha();
  const { diskId } = await seedDisk(orgId, { title: 'HD W', diskNo: 1, sha256, sizeBytes: HD_BYTES, writeProtected: false });
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, playsHd: true } })).status()).toBe(204);
  const { version } = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: sha256, mountedDiskId: diskId, version } })).status()).toBe(204);

  // 5,632 bytes: a whole DD track, so the refusal is the HD rule and not the
  // body-shape check that runs before it.
  const res = await request.post(`/api/device/write?disk=${diskId}&mount=${version}&track=0&session=boot-1&seq=1`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.alloc(5_632) });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'write_protected', reason: 'hd_read_only' });
});

test('an NFC tap of an HD disk on a board without playsHd is refused, not dropped', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: 'HD Tap', diskNo: 1, sha256: fakeSha(), sizeBytes: HD_BYTES });
  const res = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(res.status()).toBe(200);
  // 'too_long': the one refusal a pre-1.4.0 board shows (src/lib/nfc/rules.ts tapRefusalOutcome).
  expect((await res.json()).outcome).toBe('too_long');
});
```

- [ ] **Step 8: Confirm the migration is live, then run the new spec**

Do not start this step until the controller has confirmed Task 2 Step 9. Check that the column is really there:

```bash
pnpm exec dotenv -e .env.local -- tsx -e "import { neon } from '@neondatabase/serverless'; const q = neon(process.env.DATABASE_URL!); q\`select 1 from information_schema.columns where table_name = 'devices' and column_name = 'plays_hd'\`.then((r) => console.log(r.length ? 'plays_hd present' : 'plays_hd MISSING'))"
```

Expected: `plays_hd present`. If it prints MISSING, stop and tell the controller.

Check port 3100 (`lsof -nP -iTCP:3100 -sTCP:LISTEN`). If something you did not start is listening, stop and ask. Then run, in the foreground, with a 540,000 ms tool timeout:

```bash
PORT=3100 pnpm exec playwright test e2e/hd-disks.spec.ts --reporter=line
```

Expected: `5 passed`.

- [ ] **Step 9: Run the neighbouring specs this task touched**

Run each line separately, in the foreground (each is well under 9 minutes):

```bash
PORT=3100 pnpm exec playwright test e2e/hfe-disks.spec.ts e2e/device-poll.spec.ts e2e/nfc-tap.spec.ts --reporter=line
PORT=3100 pnpm exec playwright test e2e/device-write.spec.ts e2e/game-detail.spec.ts e2e/library-type-column.spec.ts --reporter=line
PORT=3100 pnpm exec playwright test e2e/view-toggle.spec.ts e2e/mobile.spec.ts --reporter=line
```

Expected: every run is all passed. When you are finished, stop the dev server Playwright started on 3100 **by its PID only** (`lsof -nP -iTCP:3100 -sTCP:LISTEN`, then `kill <that pid>`).

- [ ] **Step 10: Commit**

```bash
git add src/components/disks/hd-tag.tsx src/components/games/disk-row.tsx src/components/games/write-protect-toggle.tsx \
  src/lib/queries.ts src/components/library/game-table.tsx src/components/ingest/dropzone.tsx \
  "src/app/(app)/disks/[id]/files/page.tsx" src/lib/live-state.ts src/lib/live-state.test.ts \
  src/lib/drive-chips.ts src/lib/drive-chips.test.ts src/components/shell/drive-chips.tsx e2e/hd-disks.spec.ts
git commit -F- <<'EOF'
hd: HD tag beside the size, write-protect locked, "can't be browsed" in the file browser; e2e

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 5: Firmware — the C ADF→MFM encoder and its Greaseweazle oracle

**Files:**
- From the spike (`git checkout spike/hd-floppy -- …`), then modify: `wifi-floppy/firmware/src/adf_mfm.h`, `wifi-floppy/firmware/src/adf_mfm.c`, `wifi-floppy/firmware/test/test_adf_mfm.c`, `wifi-floppy/firmware/test/fixtures/adf_mfm_hd/*.mfm` (8 files), `scripts/adf-mfm-hd-fixtures.py`, `scripts/adf-mfm-real-fixtures.ts`
- Create (generated): `wifi-floppy/firmware/test/fixtures/adf_mfm_hd/prng-digests.txt`
- Modify: `wifi-floppy/firmware/CMakeLists.txt:55-72` (add `src/adf_mfm.c`), `package.json` (scripts)

**Interfaces:**
- Produces (C, `adf_mfm.h`): `ADF_MFM_SECTOR_BYTES 512u`, `ADF_MFM_SECTOR_MFM_BYTES 1088u`, `ADF_MFM_TRACKS 160u`, `ADF_MFM_DD_SECTORS 11u`, `ADF_MFM_HD_SECTORS 22u`, `ADF_MFM_DD_TRACK_BYTES 12668u`, `ADF_MFM_HD_TRACK_BYTES 25336u`, `ADF_MFM_HD_TRACK_BITS 202688u`; `uint32_t adf_mfm_track_bytes(unsigned nsec)`; `uint32_t adf_mfm_encode_track(const uint8_t *data, unsigned nsec, unsigned track_no, uint8_t *out)`, which returns the bytes written or 0.
- Produces (fixture): `wifi-floppy/firmware/test/fixtures/adf_mfm_hd/prng-digests.txt`, 160 lines of `<track> <sha256 hex>`: Greaseweazle's AmigaDOS_HD encoding of each track of the synthetic `prng` HD disk (xorshift32 seed `0x12345678` over all 1,802,240 bytes). Task 7 reads it.

- [ ] **Step 1: Bring the spike's files over**

```bash
cd /Users/sfs/Devel/webadf/.claude/worktrees/hd-floppies
git checkout spike/hd-floppy -- wifi-floppy/firmware/src/adf_mfm.c wifi-floppy/firmware/src/adf_mfm.h \
  wifi-floppy/firmware/test/test_adf_mfm.c wifi-floppy/firmware/test/fixtures/adf_mfm_hd \
  scripts/adf-mfm-hd-fixtures.py scripts/adf-mfm-real-fixtures.ts
git status --short
```

Expected: exactly those paths as new (`A`). Do **not** check out `main.c`, `bus_out.*`, `floppy.pio`, `drive_id.*`, `dskchg.c` or `CMakeLists.txt` from the spike: its `WF_HD_SPIKE` timing code and the `sel_off_count` diagnostic are not carried.

- [ ] **Step 2: Write the failing all-tracks test**

In `wifi-floppy/firmware/test/test_adf_mfm.c`, replace the first comment line `// HD spike: the C ADF->MFM encoder (src/adf_mfm.c) against three oracles.` with `// The C ADF->MFM encoder (src/adf_mfm.c) against three oracles (HD spec §5.2).`, add `#include "../src/sha256.h"` after the `adf_mfm.h` include, and add before `int main`:

```c
// All 160 tracks, not four: every track of the synthetic 'prng' disk against
// Greaseweazle's own digest of it (prng-digests.txt, written by
// scripts/adf-mfm-hd-fixtures.py). The track number and side go into every
// sector header, so a mistake that shows on only some tracks cannot hide
// behind the four full fixtures above.
static void hd_all_tracks_match_greaseweazle_digests(void) {
    FILE *f = fopen("fixtures/adf_mfm_hd/prng-digests.txt", "r");
    CHECK(f != NULL, "fixtures/adf_mfm_hd/prng-digests.txt (scripts/adf-mfm-hd-fixtures.py)");
    if (!f) return;
    uint8_t *adf = malloc(HD_BYTES);
    static uint8_t out[ADF_MFM_HD_TRACK_BYTES];
    synthetic("prng", adf, HD_BYTES, 1760);
    unsigned seen = 0, bad = 0, tno;
    char want[65];
    while (fscanf(f, "%u %64s", &tno, want) == 2) {
        CHECK(tno < ADF_MFM_TRACKS, "track number in range");
        if (tno >= ADF_MFM_TRACKS) break;
        CHECK_EQ_INT(adf_mfm_encode_track(adf + tno * ADF_MFM_HD_SECTORS * 512u,
                                          ADF_MFM_HD_SECTORS, tno, out), ADF_MFM_HD_TRACK_BYTES);
        sha256_t s;
        uint8_t d[32];
        char got[65];
        sha256_init(&s);
        sha256_update(&s, out, sizeof out);
        sha256_final(&s, d);
        sha256_hex(d, got);
        if (strcmp(got, want) != 0) {
            if (!bad) printf("  track %u differs from Greaseweazle (first of any)\n", tno);
            bad++;
        }
        seen++;
    }
    fclose(f);
    free(adf);
    CHECK_EQ_INT(seen, ADF_MFM_TRACKS);
    CHECK_EQ_INT(bad, 0);
}

static void hd_track_bits_is_the_encoded_length(void) {
    CHECK_EQ_INT(ADF_MFM_HD_TRACK_BITS, ADF_MFM_HD_TRACK_BYTES * 8u);
    CHECK_EQ_INT(ADF_MFM_HD_TRACK_BITS % 32u, 0);   // main.c's DMA re-triggers on whole words
}
```

and add `RUN(hd_all_tracks_match_greaseweazle_digests);` and `RUN(hd_track_bits_is_the_encoded_length);` to `main` before `return REPORT();`.

- [ ] **Step 3: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_adf_mfm|COMPILE FAIL|CRASHED|FAIL "`
Expected: `COMPILE FAIL: test_adf_mfm.c`, because `ADF_MFM_HD_TRACK_BITS` is undeclared.

- [ ] **Step 4: The header, and the fixture generator**

Replace the header comment block of `wifi-floppy/firmware/src/adf_mfm.h` (from the first `// ----` line through the closing `// ----`) with:

```c
// ---------------------------------------------------------------------------
// ADF track -> Amiga MFM, on the board (HD spec 2026-09-26 §5.2).
//
// A C port of src/lib/adfmfm/track.ts + mfm.ts (encodeTrack), which is
// byte-identical to Greaseweazle's amiga.amigados codec for DD. Pure C, no
// SDK: host-tested in test/test_adf_mfm.c against
//   * the committed Greaseweazle DD fixtures in src/lib/adfmfm/fixtures,
//   * Greaseweazle HD fixtures (AmigaDOS_HD) in test/fixtures/adf_mfm_hd,
//     four whole tracks plus a digest of all 160,
//   * the TS encoder's output for real disks (scripts/adf-mfm-real-fixtures.ts),
//     when that script has been run.
// track_cache.c calls it for every track of an HD disk (an ADF_HD slot);
// measured on the RP2350 at the spike: median 3.7 ms a track from SRAM,
// 4.1 ms reading the ADF from PSRAM, worst seen 4.9 ms.
//
// Layout, from Greaseweazle's AmigaDOS.master_track():
//   lead gap  128 * (nsec/11) raw zero bytes, odd/even encoded -> 256 (DD) / 512 (HD)
//   nsec sectors of 1,088 MFM bytes, sector n at position n with id n
//   trail gap zeros up to (int(0.2 s / clock) + 31) & ~31 bits, where clock is
//             14/7093790 s (DD) or half that (HD) -> 101,344 / 202,688 bits.
// HD is the same 2 us-class cell at 150 rpm as DD at 300: GW models it as a
// half cell at 0.2 s per rev, which is the same bit count. The board streams
// every track at one 2 us cell, so an HD revolution simply lasts 400 ms.
// ---------------------------------------------------------------------------
```

and after `#define ADF_MFM_HD_TRACK_BYTES   25336u   // 202,688 bits` add:

```c
#define ADF_MFM_HD_TRACK_BITS    202688u  // what track_cache_get reports for an HD track
```

Replace `scripts/adf-mfm-hd-fixtures.py` with:

```python
#!/usr/bin/env python3
"""Greaseweazle's AmigaDOS_HD MFM for a synthetic HD disk: the independent
oracle for the firmware's HD encoder (wifi-floppy/firmware/src/adf_mfm.c) and
for the whole WFAD -> loader -> track cache path (test_track_cache_hd.c).

MUST run under ~/.local/pipx/venvs/greaseweazle/bin/python (pnpm firmware:hd-fixtures).

    adf-mfm-hd-fixtures.py <out-dir>

Writes, for the synthetic kinds 'prng' and 'bootblock' (src/lib/adfmfm/
synthetic.ts's, over 1,802,240 bytes instead of 901,120):
  <kind>-t<NNN>.mfm   tracks 0, 1, 80 and 159 in full (25,336 bytes each)
  prng-digests.txt    "<track> <sha256>" for all 160 tracks of 'prng'
Synthetic only: nothing derived from a real disk enters the repo. The C tests
regenerate the same bytes with the same xorshift32, so any drift between the
two fails them.
"""
import hashlib
import os
import sys
from greaseweazle.codec.amiga import amigados

HD_BYTES = 22 * 512 * 160
TRACK_BYTES = 22 * 512
MFM_BYTES = 25336
TRACKS = [0, 1, 80, 159]

def fill(buf, start, seed):
    x = seed
    for i in range(start, len(buf)):
        x ^= (x << 13) & 0xffffffff
        x ^= x >> 17
        x ^= (x << 5) & 0xffffffff
        buf[i] = x & 0xff

def synthetic(kind):
    b = bytearray(HD_BYTES)
    if kind == 'prng':
        fill(b, 0, 0x12345678)
    elif kind == 'bootblock':
        b[0:4] = b'DOS\0'
        b[8:12] = (1760).to_bytes(4, 'big')   # HD root block
        fill(b, 12, 0xdeadbeef)
    return b

def encode(raw, tno):
    trk = amigados.AmigaDOS_HD(tno // 2, tno % 2)
    trk.set_img_track(raw[tno * TRACK_BYTES:(tno + 1) * TRACK_BYTES])
    mfm = trk.master_track().bits.tobytes()
    assert len(mfm) == MFM_BYTES, f't{tno}: {len(mfm)} bytes'
    return mfm

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
for kind in ['prng', 'bootblock']:
    raw = synthetic(kind)
    for tno in TRACKS:
        path = os.path.join(out_dir, f'{kind}-t{tno:03d}.mfm')
        with open(path, 'wb') as f:
            f.write(encode(raw, tno))
        print(f'wrote {path}')
    if kind == 'prng':
        path = os.path.join(out_dir, 'prng-digests.txt')
        with open(path, 'w') as f:
            for tno in range(160):
                f.write(f'{tno} {hashlib.sha256(encode(raw, tno)).hexdigest()}\n')
        print(f'wrote {path}')
```

In `package.json` `scripts`, after the `"adfmfm:diff"` entry, add:

```json
    "firmware:hd-fixtures": "~/.local/pipx/venvs/greaseweazle/bin/python scripts/adf-mfm-hd-fixtures.py wifi-floppy/firmware/test/fixtures/adf_mfm_hd",
```

In the header comment of `scripts/adf-mfm-real-fixtures.ts`, replace `// HD spike (2026-09-26): the TS encoder's MFM for real disks, as fixtures for` with `// The TS encoder's MFM for real disks (HD spec §5.2), as fixtures for`. Nothing else in it changes.

- [ ] **Step 5: Generate the fixtures and check the eight full tracks did not move**

```bash
pnpm firmware:hd-fixtures
git status --short wifi-floppy/firmware/test/fixtures/adf_mfm_hd
wc -l wifi-floppy/firmware/test/fixtures/adf_mfm_hd/prng-digests.txt
```

Expected: the eight `.mfm` files are **unmodified** (the same Greaseweazle output the spike committed), `prng-digests.txt` is new, and it has 160 lines. The first line is `0 ac3cfda1078165a54399f61e9d7af38475fecfce3b2a12c5628519ddc0b26731` (measured while planning).

- [ ] **Step 6: Add the encoder to the device build**

In `wifi-floppy/firmware/CMakeLists.txt`, in `add_executable(wifi_floppy …)`, change `src/mfm.c src/write_back.c src/reinsert.c …` to `src/mfm.c src/adf_mfm.c src/write_back.c src/reinsert.c …` (the rest of the line is unchanged).

- [ ] **Step 7: Run the host suite and the device build**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -40`
Expected: `test_adf_mfm.c: … checks, 0 failed`, with `hd_all_tracks_match_greaseweazle_digests` among the run tests; every other file 0 failed, and no COMPILE FAIL or CRASHED. `dd_real_disks_match_ts` prints `SKIPPED` unless `test/.build/adf_mfm_real` exists, which is fine.

Run: `pnpm firmware:build 2>&1 | tail -5`
Expected: the build finishes with no warnings from `adf_mfm.c`.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/adf_mfm.c wifi-floppy/firmware/src/adf_mfm.h wifi-floppy/firmware/test/test_adf_mfm.c \
  wifi-floppy/firmware/test/fixtures/adf_mfm_hd scripts/adf-mfm-hd-fixtures.py scripts/adf-mfm-real-fixtures.ts \
  wifi-floppy/firmware/CMakeLists.txt package.json
git commit -F- <<'EOF'
firmware: C ADF->MFM encoder for DD and HD, held to Greaseweazle on all 160 HD tracks

From spike/hd-floppy (c996ee6), without its timing build. prng-digests.txt
is Greaseweazle's sha-256 of every track of the synthetic HD disk.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 6: Firmware — the slot kind and the WFAD loader

**Files:**
- Modify: `wifi-floppy/firmware/src/psram_image.h` (after `SLOT_NONE`, line 48; `psram_image_read` comment :67), `wifi-floppy/firmware/src/psram_image.c` (:33-36 metadata, :87-91 init, :138-156, :226-230)
- Modify: `wifi-floppy/firmware/src/image_loader.h` (:26-34, :50-55), `wifi-floppy/firmware/src/image_loader.c` (:11-20, :28-89)
- Modify: `wifi-floppy/firmware/src/device_client.c:572-573` (log wording)
- Create: `wifi-floppy/firmware/test/test_image_loader_wfad.c`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `psram_image.h`: `typedef enum { SLOT_KIND_MFM = 0, SLOT_KIND_ADF_HD } slot_kind_t;`, `void psram_image_set_slot_kind(int slot, slot_kind_t kind);`, `slot_kind_t psram_image_slot_kind(int slot);` (MFM for `SLOT_NONE` or out of range), `const uint8_t *psram_image_track_data(int slot, int track);` (NULL if absent). `psram_image_read` returns false on an ADF_HD slot. `psram_image_mark_dirty` does nothing on an ADF_HD slot. `psram_image_reset_slot` resets the kind to MFM.
  - `image_loader.h`: `WFAD_MAGIC 0x44414657u`, `WFAD_VERSION 1u`, `WFAD_TRACKS 160u`, `WFAD_SECTORS 22u`, `WFAD_TRACK_BYTES 11264u`, `WFAD_BODY_BYTES 1802240u`. `image_parse_*` accept a WFAD and commit each track with `bit_count = WFAD_TRACK_BYTES * 8`.

- [ ] **Step 1: Write the failing test**

Create `wifi-floppy/firmware/test/test_image_loader_wfad.c`:

```c
#include "harness.h"
#include "../src/image_loader.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

// WFAD (HD spec §4.4, §5.1): the loader takes an HD ADF whole or not at all.
// The slot it fills becomes ADF_HD; a rejected image leaves the slot empty
// AND back to MFM, so nothing half-loaded can ever be published.

#define WFAD_TOTAL (16u + WFAD_BODY_BYTES)
static uint8_t *img;    // WFAD_TOTAL + 1 bytes: room for the one-too-many case

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// A valid WFAD whose every byte says where it is.
static void build(void) {
    put_u32(img, WFAD_MAGIC); put_u32(img + 4, WFAD_VERSION);
    put_u32(img + 8, WFAD_TRACKS); put_u32(img + 12, WFAD_SECTORS);
    for (uint32_t t = 0; t < WFAD_TRACKS; t++)
        for (uint32_t i = 0; i < WFAD_TRACK_BYTES; i++)
            img[16 + t * WFAD_TRACK_BYTES + i] = (uint8_t)(t ^ (i * 7u));
}

static void the_spec_header_is_what_the_loader_reads(void) {
    // Spelled out from the spec's table, as src/lib/adfmfm/wfad.test.ts does
    // on the server side: both ends are held to the same 16 bytes.
    static const uint8_t hdr[16] = { 0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0,
                                     0xa0, 0, 0, 0, 0x16, 0, 0, 0 };
    build();
    CHECK(memcmp(img, hdr, sizeof hdr) == 0, "WFAD header bytes match the spec table");
    CHECK_EQ_INT(WFAD_TOTAL, 1802256);
    CHECK_EQ_INT(WFAD_TRACKS, NUM_TRACKS);
}

static void a_valid_wfad_loads_every_track_as_adf_hd(void) {
    build();
    CHECK(image_parse_buffer(0, img, WFAD_TOTAL), "a valid WFAD must load");
    CHECK_EQ_INT(psram_image_slot_kind(0), SLOT_KIND_ADF_HD);
    CHECK_EQ_INT(psram_image_missing_count(0), 0);
    for (int t = 0; t < NUM_TRACKS; t += 53) {
        const uint8_t *p = psram_image_track_data(0, t);
        CHECK(p != NULL, "track present");
        CHECK(p && memcmp(p, img + 16 + (uint32_t)t * WFAD_TRACK_BYTES, WFAD_TRACK_BYTES) == 0,
              "the track's ADF bytes, in place");
        CHECK_EQ_INT(psram_image_bits(0, t), WFAD_TRACK_BYTES * 8u);
    }
    // These bytes are ADF, not MFM: the copy-out path must never hand them
    // to something that would stream them.
    static uint8_t dst[TRACK_MAX_BYTES];
    uint32_t bits = 0;
    CHECK(!psram_image_read(0, 0, dst, &bits), "an ADF_HD slot is never read out as MFM");
}

static void one_byte_at_a_time_is_the_same_and_a_trailing_byte_is_not(void) {
    build();
    image_parse_begin(1);
    for (uint32_t i = 0; i < WFAD_TOTAL; i++) image_parse_feed(img + i, 1);
    CHECK(image_parse_end(), "fed one byte at a time");
    CHECK_EQ_INT(psram_image_slot_kind(1), SLOT_KIND_ADF_HD);

    image_parse_begin(1);
    for (uint32_t i = 0; i < WFAD_TOTAL; i++) image_parse_feed(img + i, 1);
    image_parse_feed(img, 1);          // one byte after the last track
    CHECK(!image_parse_end(), "a byte after the last track rejects the image");
    CHECK_EQ_INT(psram_image_missing_count(1), NUM_TRACKS);
}

static void rejected_whole(const char *why, size_t len) {
    CHECK(!image_parse_buffer(0, img, len), why);
    CHECK_EQ_INT(psram_image_missing_count(0), NUM_TRACKS);   // nothing left behind
    CHECK_EQ_INT(psram_image_slot_kind(0), SLOT_KIND_MFM);    // and the kind reset with it
}

static void malformed_containers_are_rejected_whole(void) {
    build(); put_u32(img + 4, 2);   rejected_whole("version 2", WFAD_TOTAL);
    build(); put_u32(img + 8, 159); rejected_whole("159 tracks", WFAD_TOTAL);
    build(); put_u32(img + 12, 11); rejected_whole("11 sectors (DD geometry)", WFAD_TOTAL);
    build();                        rejected_whole("one byte short", WFAD_TOTAL - 1);
    build();                        rejected_whole("the header alone", 16);
    build(); img[WFAD_TOTAL] = 0;   rejected_whole("one byte too many", WFAD_TOTAL + 1);
}

static void a_wfmf_after_a_wfad_in_the_same_slot_is_mfm_again(void) {
    build();
    CHECK(image_parse_buffer(0, img, WFAD_TOTAL), "WFAD first");
    // The smallest valid WFMF: 160 tracks of 16 bytes (128 bits), no padding.
    size_t at = 16;
    put_u32(img, IMAGE_MAGIC); put_u32(img + 4, IMAGE_VERSION);
    put_u32(img + 8, NUM_TRACKS); put_u32(img + 12, 0);
    for (int t = 0; t < NUM_TRACKS; t++) {
        put_u32(img + at, 128u); at += 4;
        memset(img + at, t, 16); at += 16;
    }
    CHECK(image_parse_buffer(0, img, at), "then a WFMF into the same slot");
    CHECK_EQ_INT(psram_image_slot_kind(0), SLOT_KIND_MFM);
    static uint8_t dst[TRACK_MAX_BYTES];
    uint32_t bits = 0;
    CHECK(psram_image_read(0, 3, dst, &bits) && bits == 128u && dst[0] == 3, "an MFM slot reads out as before");
}

int main(void) {
    size_t len = (size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES;
    psram_image_set_backing(malloc(len), len);
    psram_image_init();
    img = malloc(WFAD_TOTAL + 1);
    RUN(the_spec_header_is_what_the_loader_reads);
    RUN(a_valid_wfad_loads_every_track_as_adf_hd);
    RUN(one_byte_at_a_time_is_the_same_and_a_trailing_byte_is_not);
    RUN(malformed_containers_are_rejected_whole);
    RUN(a_wfmf_after_a_wfad_in_the_same_slot_is_mfm_again);
    free(img);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "wfad|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_image_loader_wfad.c`, because `WFAD_MAGIC`, `psram_image_slot_kind` and the other new names are undeclared.

- [ ] **Step 3: The slot kind**

In `wifi-floppy/firmware/src/psram_image.h`, after `#define SLOT_NONE  (-1)` add:

```c

// What a slot's tracks hold (HD spec §5.1). MFM: ready to stream -- WFMF,
// DD and HFE alike. ADF_HD: each track is an HD ADF's 22 x 512 = 11,264
// sector bytes, encoded to MFM by track_cache_get() when the head arrives.
// image_loader.c sets it before the first track lands; psram_image_reset_slot()
// puts it back to MFM. core1 writes it before psram_publish_slot(), whose
// release barrier makes it visible to core0 with the tracks.
typedef enum { SLOT_KIND_MFM = 0, SLOT_KIND_ADF_HD } slot_kind_t;

void        psram_image_set_slot_kind(int slot, slot_kind_t kind);
slot_kind_t psram_image_slot_kind(int slot);      // MFM for SLOT_NONE or out of range
```

Replace the two lines

```c
// Copy a track out of PSRAM into an SRAM destination. False if not present.
bool psram_image_read(int slot, int track, uint8_t *dst, uint32_t *bit_count);
```

with

```c
// Copy a track out of PSRAM into an SRAM destination. False if not present,
// and false for an ADF_HD slot: its bytes are ADF, not MFM, and must never
// reach anything that would stream them.
bool psram_image_read(int slot, int track, uint8_t *dst, uint32_t *bit_count);

// The track's bytes in place, NULL if absent. For track_cache.c's HD encode,
// which reads the ADF straight from PSRAM (4.1 ms a track measured, vs 3.7
// from SRAM). core0 only; never a DMA source (see above).
const uint8_t *psram_image_track_data(int slot, int track);
```

and change the comment line above `psram_image_mark_dirty` to:

```c
// Host wrote this track: keep the data, mark for later flush to the server.
// Does nothing on an ADF_HD slot: HD is read-only in this release (spec §5.3).
```

In `wifi-floppy/firmware/src/psram_image.c`: after `static track_state_t state[SLOT_COUNT][NUM_TRACKS];` add `static slot_kind_t   kind[SLOT_COUNT];`. In `psram_image_init`, after `memset(state, 0, sizeof state);` add `memset(kind, 0, sizeof kind);    // SLOT_KIND_MFM`. In `psram_image_read`, after `if (!psram_image_have(slot, track)) return false;` add:

```c
    if (kind[slot] == SLOT_KIND_ADF_HD) return false;   // ADF bytes, not MFM (header)
```

In `store()`, after its first guard line add:

```c
    if (kind[slot] == SLOT_KIND_ADF_HD) return;         // HD is read-only (spec §5.3)
```

In `psram_image_reset_slot`, after `memset(state[slot], 0, sizeof state[slot]);` add `kind[slot] = SLOT_KIND_MFM;`. Before `// The one place `active_slot` is ever written…` add:

```c
void psram_image_set_slot_kind(int slot, slot_kind_t k) {
    if (slot_ok(slot)) kind[slot] = k;
}

slot_kind_t psram_image_slot_kind(int slot) {
    return slot_ok(slot) ? kind[slot] : SLOT_KIND_MFM;
}

const uint8_t *psram_image_track_data(int slot, int track) {
    if (!psram_image_have(slot, track)) return NULL;
    return track_ptr(slot, track);
}

```

- [ ] **Step 4: The WFAD parse**

In `wifi-floppy/firmware/src/image_loader.h`, after `#define IMAGE_VERSION 1u` add:

```c

// An HD disk (spec 2026-09-26-hd-floppies §4.4) arrives as WFAD instead: the
// ADF itself, which the board encodes a track at a time on read.
//   u32 magic 'WFAD' (0x44414657 LE)
//   u32 version (1)
//   u32 tracks (160)
//   u32 sectors per track (22)
//   then 160 x 11,264 bytes, track-major (track = cylinder * 2 + head)
// Validated whole: any other version or geometry, a short body, or ONE byte
// too many rejects the image, and the slot is left empty and MFM.
#define WFAD_MAGIC        0x44414657u
#define WFAD_VERSION      1u
#define WFAD_TRACKS       160u
#define WFAD_SECTORS      22u
#define WFAD_TRACK_BYTES  (WFAD_SECTORS * 512u)              // 11,264
#define WFAD_BODY_BYTES   (WFAD_TRACKS * WFAD_TRACK_BYTES)   // 1,802,240
```

and in the `image_parse_end` comment change "forms a complete, well-formed WFMF container" to "forms a complete, well-formed WFMF or WFAD container".

In `wifi-floppy/firmware/src/image_loader.c`: after `#include <stddef.h>` add

```c

_Static_assert(WFAD_TRACKS == NUM_TRACKS, "a WFAD names every track of the disk");
_Static_assert(WFAD_TRACK_BYTES <= TRACK_MAX_BYTES, "an HD track's ADF bytes fit a PSRAM slot track");
```

In `loader_t`, after `uint32_t bits, payload_bytes, payload_got, pad_left;` add:

```c
    bool     adf;           // a WFAD: fixed-size tracks back to back, nothing after the last
```

In `sink`'s `case S_HDR:`, replace

```c
            if (l->hdr_got < 16) return;
            if (le32(l->hdr) != IMAGE_MAGIC || le32(l->hdr + 4) != IMAGE_VERSION) {
```

with

```c
            if (l->hdr_got < 16) return;
            if (le32(l->hdr) == WFAD_MAGIC) {
                // HD (spec §5.1): the header must name exactly this geometry
                // before a byte is stored.
                if (le32(l->hdr + 4) != WFAD_VERSION || le32(l->hdr + 8) != WFAD_TRACKS ||
                    le32(l->hdr + 12) != WFAD_SECTORS) {
                    l->st = S_ERR; return;
                }
                psram_image_set_slot_kind(l->slot, SLOT_KIND_ADF_HD);
                l->adf = true;
                l->track_count = (int)WFAD_TRACKS;
                l->track = 0;
                l->bits = WFAD_TRACK_BYTES * 8u;
                l->payload_bytes = WFAD_TRACK_BYTES;
                l->payload_got = 0;
                l->st = S_PAYLOAD;
                break;
            }
            if (le32(l->hdr) != IMAGE_MAGIC || le32(l->hdr + 4) != IMAGE_VERSION) {
```

In `case S_PAYLOAD:`, replace

```c
            psram_image_commit(l->slot, l->track, l->bits);
            l->st = l->pad_left ? S_PAD : S_LEN;
```

with

```c
            psram_image_commit(l->slot, l->track, l->bits);
            if (l->adf) {
                // Fixed-size tracks back to back: no length words, no padding.
                l->payload_got = 0;
                if (++l->track >= l->track_count) l->st = S_EOF;
                break;
            }
            l->st = l->pad_left ? S_PAD : S_LEN;
```

At the end of `sink`, after the `while` loop's closing brace and before the function's closing brace, add:

```c
    // WFAD's size is exact (spec §5.1): a byte after the last track is a
    // malformed container, not slack to ignore. WFMF keeps its old rule.
    if (l->adf && l->st == S_EOF && n > 0) l->st = S_ERR;
```

(Every `return` inside the loop happens with the chunk used up, `n == 0`, so this one check covers both a chunk that runs past the end and a chunk that arrives after it.)

In `wifi-floppy/firmware/src/device_client.c`, change the log text `"valid WFMF container -- digest blocked"` to `"valid WFMF or WFAD container -- digest blocked"`, and in the comment above it `a well-formed, complete WFMF container` to `a well-formed, complete WFMF or WFAD container`.

- [ ] **Step 5: Run the host suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -40`
Expected: `test_image_loader_wfad.c: … checks, 0 failed`. `test_image_loader.c`, `test_psram_image.c`, `test_track_cache.c`, `test_write_back.c` and `test_device_client.c` are all still 0 failed, and there is no COMPILE FAIL.

- [ ] **Step 6: Device build**

Run: `pnpm firmware:build 2>&1 | tail -5`
Expected: it builds cleanly.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/psram_image.h wifi-floppy/firmware/src/psram_image.c \
  wifi-floppy/firmware/src/image_loader.h wifi-floppy/firmware/src/image_loader.c \
  wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/test/test_image_loader_wfad.c
git commit -F- <<'EOF'
firmware: WFAD loads an HD ADF into a PSRAM slot marked ADF_HD, whole or not at all

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 7: Firmware — encode HD tracks on read, bigger SRAM buffers, end-to-end against Greaseweazle

**Files:**
- Modify: `wifi-floppy/firmware/src/track_cache.h` (defines; `track_cache_get` comment :44-54)
- Modify: `wifi-floppy/firmware/src/track_cache.c` (:5-7 includes, :27 buffer, :75-87)
- Modify: `wifi-floppy/firmware/src/main.c` (:315 `track_words`; the core0 loop near :2258-2268; a heap helper after `clock_ms` :587)
- Create: `wifi-floppy/firmware/test/test_track_cache_hd.c`

**Interfaces:**
- Consumes: `adf_mfm_encode_track`, `ADF_MFM_HD_*` (Task 5); `psram_image_slot_kind`, `psram_image_track_data`, `SLOT_KIND_ADF_HD`, `WFAD_*`, `image_parse_buffer` (Task 6); `fixtures/adf_mfm_hd/prng-digests.txt` (Task 5).
- Produces: `TRACK_BUF_BYTES 25344u` (in `track_cache.h`). `track_cache_get` returns the encoded MFM with `*bit_count = 202688` for an ADF_HD slot. `track_cache_buf_bytes() == TRACK_BUF_BYTES`.

- [ ] **Step 1: Write the failing test**

Create `wifi-floppy/firmware/test/test_track_cache_hd.c`:

```c
#include "harness.h"
#include "../src/track_cache.h"
#include "../src/psram_image.h"
#include "../src/image_loader.h"
#include "../src/adf_mfm.h"
#include "../src/sha256.h"
#include <stdlib.h>
#include <string.h>

// HD spec §7, firmware: WFAD -> image_loader -> track_cache_get, all 160
// tracks, held to GREASEWEAZLE's encoding of the same disk
// (fixtures/adf_mfm_hd/prng-digests.txt, scripts/adf-mfm-hd-fixtures.py) --
// never to adf_mfm.c's own output, which would only prove the code agrees
// with itself. Plus the stale-track guarantee for ADF_HD slots.

#define HD_ADF_BYTES (WFAD_TRACKS * WFAD_TRACK_BYTES)
static uint8_t *wfad;    // 16 + HD_ADF_BYTES

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// synthetic.ts's xorshift32 over the whole disk: with seed 0x12345678 this is
// exactly the 'prng' disk the fixture script feeds Greaseweazle.
static void build_wfad(uint32_t seed) {
    put_u32(wfad, WFAD_MAGIC); put_u32(wfad + 4, WFAD_VERSION);
    put_u32(wfad + 8, WFAD_TRACKS); put_u32(wfad + 12, WFAD_SECTORS);
    uint32_t x = seed;
    for (uint32_t i = 0; i < HD_ADF_BYTES; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        wfad[16 + i] = (uint8_t)x;
    }
}

static void digest(const uint8_t *p, uint32_t n, char hex[65]) {
    sha256_t s;
    uint8_t d[32];
    sha256_init(&s);
    sha256_update(&s, p, n);
    sha256_final(&s, d);
    sha256_hex(d, hex);
}

static void buffers_hold_an_encoded_hd_track(void) {
    CHECK_EQ_INT(track_cache_buf_bytes(), TRACK_BUF_BYTES);
    CHECK(TRACK_BUF_BYTES >= ADF_MFM_HD_TRACK_BYTES, "an encoded HD track fits the SRAM buffer");
    CHECK(TRACK_BUF_BYTES >= TRACK_MAX_BYTES, "and so does any PSRAM track");
}

static void every_track_matches_greaseweazle(void) {
    FILE *f = fopen("fixtures/adf_mfm_hd/prng-digests.txt", "r");
    CHECK(f != NULL, "fixtures/adf_mfm_hd/prng-digests.txt (scripts/adf-mfm-hd-fixtures.py)");
    if (!f) return;
    static char want[NUM_TRACKS][65];
    unsigned tno, n = 0;
    char hex[65];
    while (n < NUM_TRACKS && fscanf(f, "%u %64s", &tno, hex) == 2) {
        if (tno < NUM_TRACKS) { memcpy(want[tno], hex, sizeof hex); n++; }
    }
    fclose(f);
    CHECK_EQ_INT(n, NUM_TRACKS);

    track_cache_init();
    build_wfad(0x12345678u);
    const int slot = psram_inactive_slot();
    CHECK(image_parse_buffer(slot, wfad, 16 + HD_ADF_BYTES), "the WFAD loads");
    psram_publish_slot(slot);

    // First as a seeking head asks -- out of order, with repeats, so answers
    // land in both halves of the double buffer -- then every track in order.
    static const int seek[] = { 0, 159, 1, 80, 80, 2, 158, 0, 5, 4, 5 };
    const int nseek = (int)(sizeof seek / sizeof seek[0]);
    unsigned bad = 0;
    for (int i = 0; i < nseek + NUM_TRACKS; i++) {
        const int t = i < nseek ? seek[i] : i - nseek;
        uint32_t bits = 0;
        const uint8_t *mfm = track_cache_get(t, &bits);
        CHECK(mfm != NULL, "an HD track is served");
        if (!mfm) { bad++; continue; }
        CHECK_EQ_INT(bits, ADF_MFM_HD_TRACK_BITS);
        char got[65];
        digest(mfm, ADF_MFM_HD_TRACK_BYTES, got);
        if (strcmp(got, want[t]) != 0) {
            if (!bad) printf("  track %d (request %d) differs from Greaseweazle\n", t, i);
            bad++;
        }
    }
    CHECK_EQ_INT(bad, 0);
}

static void an_hd_disk_never_serves_another_disks_track(void) {
    static uint8_t want[ADF_MFM_HD_TRACK_BYTES];
    uint32_t bits = 0;
    track_cache_init();

    // Disk A (HD) in slot 0: cache its track 5.
    build_wfad(0x11111111u);
    CHECK(image_parse_buffer(0, wfad, 16 + HD_ADF_BYTES), "disk A loads");
    psram_publish_slot(0);
    CHECK(track_cache_get(5, &bits) != NULL, "A's track 5");

    // Eject, then disk B (HD, other bytes) into the same slot 0.
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_inactive_slot(), 0);
    build_wfad(0x22222222u);
    CHECK(image_parse_buffer(0, wfad, 16 + HD_ADF_BYTES), "disk B loads");
    psram_publish_slot(0);
    const uint8_t *got = track_cache_get(5, &bits);
    adf_mfm_encode_track(wfad + 16 + 5u * WFAD_TRACK_BYTES, ADF_MFM_HD_SECTORS, 5, want);
    CHECK(got && memcmp(got, want, sizeof want) == 0, "B's track 5, never A's cached encode");

    // Then a DD (MFM) disk in slot 1: served as stored, not encoded.
    psram_image_reset_slot(1);
    static uint8_t dd[64];
    memset(dd, 0x5a, sizeof dd);
    for (int t = 0; t < NUM_TRACKS; t++) {
        psram_image_write_at(1, t, 0, dd, (int)sizeof dd);
        psram_image_commit(1, t, (uint32_t)sizeof dd * 8u);
    }
    psram_publish_slot(1);
    got = track_cache_get(5, &bits);
    CHECK(got && memcmp(got, dd, sizeof dd) == 0, "a DD slot after an HD one streams as stored");
    CHECK_EQ_INT(bits, sizeof dd * 8u);
}

int main(void) {
    size_t len = (size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES;
    psram_image_set_backing(malloc(len), len);
    wfad = malloc(16 + HD_ADF_BYTES);
    RUN(buffers_hold_an_encoded_hd_track);
    RUN(every_track_matches_greaseweazle);
    RUN(an_hd_disk_never_serves_another_disks_track);
    free(wfad);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "track_cache_hd|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_track_cache_hd.c`, because `TRACK_BUF_BYTES` is undeclared.

- [ ] **Step 3: The encode path**

In `wifi-floppy/firmware/src/track_cache.h`, after `#include "floppy_io.h"` add:

```c

// The SRAM staging buffers -- track_cache.c's double buffer and main.c's DMA
// word buffer -- are sized for the LONGEST track either tier hands them: an
// HD track encoded on the board, 202,688 bits = 25,336 bytes, rounded up to a
// multiple of 4 (HD spec §5.2). Separate from TRACK_MAX_BYTES (psram_image.h),
// the PSRAM stride, which stays 14 KB: an HD slot holds 11,264 ADF bytes a
// track. Costs ~33 KB of SRAM over 14336-byte buffers; the spike measured
// ~170 KB free before this.
#define TRACK_BUF_BYTES 25344u
```

Replace the comment block above `const uint8_t *track_cache_get(int track, uint32_t *bit_count);` (from `// Core 0 (see psram_image.h/.c:` through `// or the track is not in the active slot's image - do not stream anything.`) with:

```c
// Core 0 ONLY, from main()'s service loop -- thread mode, never an interrupt:
// the STEP and SIDE ISRs only set want_track, and dma_irq only re-arms from
// main.c's track_words. (Not core1: its device_client.c loop blocks for tens
// of seconds on a long poll, which would leave the flux DMA replaying a stale
// track after a seek.) Returns an SRAM buffer for 'track' from the PSRAM
// image's active slot (psram_active_slot()): copied for an MFM slot, ENCODED
// for an ADF_HD slot (adf_mfm.c, ~4 ms measured on the RP2350, HD spec §5.2;
// the previous track keeps streaming meanwhile). NULL means no disk is
// mounted or the track is not in the active slot's image - do not stream
// anything.
```

In `wifi-floppy/firmware/src/track_cache.c`: after `#include "psram_image.h"` add `#include "adf_mfm.h"`. Change `uint8_t  data[TRACK_MAX_BYTES] __attribute__((aligned(4)));` to `uint8_t  data[TRACK_BUF_BYTES] __attribute__((aligned(4)));`. After the `} sram_buf_t;` line add:

```c

_Static_assert(TRACK_BUF_BYTES >= ADF_MFM_HD_TRACK_BYTES, "an encoded HD track must fit");
_Static_assert(TRACK_BUF_BYTES >= TRACK_MAX_BYTES, "a PSRAM track must fit");
_Static_assert(TRACK_BUF_BYTES % 4u == 0, "main.c's DMA reads whole words");
```

In `track_cache_get`, directly after `sram_buf_t *dst = &buf[active ^ 1];        // fill the idle half`, insert:

```c

    // Tier 1, HD: an ADF_HD slot holds sector data, not MFM -- encode it
    // straight into the idle half (HD spec §5.2). Tagged with the same
    // token, so the stale-track guarantee above holds unchanged. The slot's
    // kind was written before its publish, so the acquire in
    // psram_active_token() above covers it.
    if (psram_image_slot_kind(slot) == SLOT_KIND_ADF_HD) {
        const uint8_t *adf = psram_image_track_data(slot, track);
        if (!adf || adf_mfm_encode_track(adf, ADF_MFM_HD_SECTORS, (unsigned)track, dst->data) == 0)
            return 0;
        dst->bit_count = ADF_MFM_HD_TRACK_BITS;
        dst->track = track;
        dst->token = token;
        active ^= 1;
        *bit_count = dst->bit_count;
        return dst->data;
    }
```

- [ ] **Step 4: Run the host suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -40`
Expected: `test_track_cache_hd.c: … checks, 0 failed`, and every other file still 0 failed. `test_image_loader.c`'s `test_read_does_not_overflow_a_track_cache_sized_buffer` still passes, because its canary now sits 25,344 bytes out.

- [ ] **Step 5: main.c — the DMA buffer, the heap low-water log and the encode timing**

Record the SRAM figure before the change: `arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | grep -E '^\.(bss|data|heap)'` (write the `.bss` value down).

In `wifi-floppy/firmware/src/main.c`: add `#include <malloc.h>` and `#include <unistd.h>` beside the other system includes. Replace line 315 `static uint32_t track_words[(TRACK_MAX_BYTES + 3) / 4];` with:

```c
// Sized for the longest track track_cache_get() can return -- an encoded HD
// track (TRACK_BUF_BYTES, track_cache.h) -- not the PSRAM stride.
static uint32_t track_words[TRACK_BUF_BYTES / 4];
```

After the `clock_ms()` function (line ~587), add:

```c
// Free heap: never-claimed space between the break and __StackLimit (the
// SDK's _sbrk refuses to grow past it, pico_clib_interface/newlib_interface.c)
// plus what malloc holds free below the break. HD spec §7 bench step 10: HD
// grew the SRAM buffers by ~33 KB, and this is the number that says what
// that left.
extern char __StackLimit;
static uint32_t heap_free_bytes(void) {
    struct mallinfo mi = mallinfo();
    return (uint32_t)(&__StackLimit - (char *)sbrk(0)) + (uint32_t)mi.fordblks;
}
```

In the core0 loop, replace

```c
            uint32_t bits;
            const uint8_t *mfm = track_cache_get(want, &bits);
            if (mfm) {
```

with

```c
            uint32_t bits;
            const uint64_t get_t0 = time_us_64();
            const uint8_t *mfm = track_cache_get(want, &bits);
            // An HD track was encoded just now (track_cache.c): say so when
            // it takes longer than any before -- the spike's worst was 4.9 ms
            // against a ~15 ms settle budget.
            static uint32_t hd_encode_max_us;
            if (mfm && bits == ADF_MFM_HD_TRACK_BITS) {
                const uint32_t us = (uint32_t)(time_us_64() - get_t0);
                if (us > hd_encode_max_us) {
                    hd_encode_max_us = us;
                    wf_logf(WF_INFO, "hd: track %d encoded in %lu us (new max)", want, (unsigned long)us);
                }
            }
            if (mfm) {
```

and add `#include "adf_mfm.h"` beside `#include "track_cache.h"`. Right after the `if (want >= 0 && want != loaded) { … }` block closes, add:

```c
        // HD spec §7 step 10: the free-heap low-water mark, logged each time
        // it drops (sampled every 5 s, so a transient dip can be missed --
        // it is a floor for the bench, not a guarantee).
        {
            static uint32_t heap_low = UINT32_MAX, heap_checked_ms;
            if (clock_ms() - heap_checked_ms >= 5000u) {
                heap_checked_ms = clock_ms();
                const uint32_t f = heap_free_bytes();
                if (f < heap_low) {
                    heap_low = f;
                    wf_logf(WF_INFO, "heap: free low-water %lu bytes", (unsigned long)f);
                }
            }
        }
```

- [ ] **Step 6: Build and measure**

Run: `pnpm firmware:build 2>&1 | tail -5 && arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | grep -E '^\.(bss|data|heap)'`
Expected: a clean build, and `.bss` larger than the Step 5 figure by about 33,024 bytes (3 × (25,344 − 14,336)). If the link fails on `mallinfo`, the toolchain linked newlib-nano: replace the helper's body with `return (uint32_t)(&__StackLimit - (char *)sbrk(0));`, change its comment to say it counts only never-claimed space, and note that in the commit message.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/track_cache.h wifi-floppy/firmware/src/track_cache.c \
  wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/test_track_cache_hd.c
git commit -F- <<'EOF'
firmware: encode HD tracks on read in core0's loop; 25 KB SRAM track buffers; heap low-water log

track_cache_get's only caller is main()'s core0 service loop (thread
mode), so the ~4 ms encode runs there while the old track keeps
streaming. All 160 tracks, through WFAD and the loader, match
Greaseweazle's digests.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 8: Firmware — HD is read-only on the board: WPROT forced, writes discarded

**Files:**
- Modify: `wifi-floppy/firmware/src/write_back.h`, `wifi-floppy/firmware/src/write_back.c`
- Modify: `wifi-floppy/firmware/test/test_write_back.c` (bound of `every_verdict_has_a_reason`; two new tests; `main`)
- Modify: `wifi-floppy/firmware/src/main.c` (WPROT block :1685-1725; `verify_next` :2224)

**Interfaces:**
- Consumes: `psram_image_slot_kind`, `SLOT_KIND_ADF_HD` (Task 6).
- Produces: `WB_REJECT_READ_ONLY` (the last `wb_verdict_t` value), whose reason is `"HD disk is read-only"`, and `bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced, bool read_only_image)`.

- [ ] **Step 1: Write the failing tests**

In `wifi-floppy/firmware/test/test_write_back.c`, change the loop bound in `every_verdict_has_a_reason` from `v <= WB_REJECT_WRONG_TRACK` to `v <= WB_REJECT_READ_ONLY`, and add before `int main`:

```c
// HD spec §5.3: an HD disk takes no writes on the board, however clean the
// capture. The verdict refuses it, and the store refuses it again below that.
static void an_hd_disk_takes_no_writes(void) {
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_READ_ONLY);
    static uint8_t adf[MFM_TRACK_DATA_BYTES];
    CHECK(!write_back_apply(0, 80, adf), "an HD slot never stores a write");
    CHECK_EQ_INT(psram_image_dirty_count(0), 0);
    psram_image_reset_slot(0);     // back to MFM, for anything that runs after
}

// The four gates on WPROT, one function so the HD one is tested (main.c's
// core1 loop only feeds it).
static void wprot_is_forced_for_an_hd_disk(void) {
    CHECK(write_back_wprot(true, false, false, true), "HD mounted, server says writable: still protected");
    CHECK(!write_back_wprot(true, false, false, false), "DD, writable, nothing forcing: released");
    CHECK(write_back_wprot(false, false, false, false), "nothing mounted: protected");
    CHECK(write_back_wprot(true, true, false, false), "the server's flag");
    CHECK(write_back_wprot(true, false, true, false), "the uploader's force");
}
```

and add `RUN(an_hd_disk_takes_no_writes);` and `RUN(wprot_is_forced_for_an_hd_disk);` as the last two `RUN`s in `main`.

- [ ] **Step 2: Run to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "write_back|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_write_back.c`, because `WB_REJECT_READ_ONLY` and `write_back_wprot` are undeclared.

- [ ] **Step 3: The verdict and the WPROT decision**

In `wifi-floppy/firmware/src/write_back.h`, after `WB_REJECT_WRONG_TRACK,      // a valid track, for a cylinder the head is not on` add:

```c
    WB_REJECT_READ_ONLY,        // an HD disk: read-only on the board (HD spec §5.3)
```

and after the `write_back_apply` declaration add:

```c

// Whether WPROT is asserted: nothing mounted, the server's flag, the
// uploader's force (up_forces_wprot), or a read-only image -- an HD disk,
// read-only in this release whatever the server sent (HD spec §5.3). Pure;
// main.c's core1 loop feeds it and drives the pin.
bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced,
                      bool read_only_image);
```

In `wifi-floppy/firmware/src/write_back.c`, in `write_back_verdict` after `if (token_now != token_at_wgate)              return WB_REJECT_DISK_CHANGED;` add:

```c
    // HD is read-only in this release (spec §5.3). WPROT is asserted for it,
    // so a write here means the Amiga ignored that: discarded -- never
    // stored, so never uploaded -- however clean its sectors are.
    if (psram_image_slot_kind(psram_token_slot(token_now)) == SLOT_KIND_ADF_HD)
        return WB_REJECT_READ_ONLY;
```

In `write_back_reason`, after the `WB_REJECT_WRONG_TRACK` case add `case WB_REJECT_READ_ONLY:    return "HD disk is read-only";`. At the end of the file add:

```c

bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced,
                      bool read_only_image) {
    return !mounted || server_protected || uploader_forced || read_only_image;
}
```

(`psram_image_mark_dirty` already refuses an ADF_HD slot, from Task 6. That is what makes `write_back_apply` return false in the test.)

- [ ] **Step 4: Run the host suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -30`
Expected: `test_write_back.c: … checks, 0 failed`, and everything else still 0 failed.

- [ ] **Step 5: Wire WPROT and the verify sweep in main.c**

In `wifi-floppy/firmware/src/main.c`'s core1 loop, replace

```c
            bool up_forced = up_forces_wprot(&up);
            bool wprot = !mounted || c.mounted_write_protected || up_forced;
```

with

```c
            bool up_forced = up_forces_wprot(&up);
            // HD spec §5.3: an HD disk is read-only here, and not only because
            // the server sends writeProtected: the board holds the line itself.
            bool hd_mounted = mounted &&
                psram_image_slot_kind(psram_active_slot()) == SLOT_KIND_ADF_HD;
            bool wprot = write_back_wprot(mounted, c.mounted_write_protected, up_forced, hd_mounted);
```

In the comment that follows, change `THREE separate gates force WPROT --` to `FOUR separate gates force WPROT --`, and change `no disk, the server's flag, and the uploader (up_forces_wprot: after a refused write, or while parked) -- and none folds into another` to `no disk, the server's flag, the uploader (up_forces_wprot: after a refused write, or while parked) and an HD image -- and none folds into another`. In the log call, replace

```c
                wf_logf(WF_INFO, "wprot: %s (mounted=%s server=%s uploader=%s)",
                        wprot ? "ASSERTED -- the Amiga cannot write" : "RELEASED -- the Amiga may write",
                        mounted ? "yes" : "no",
                        mounted ? (c.mounted_write_protected ? "protected" : "writable") : "n/a",
                        up_forced ? "forced" : "ok");
```

with

```c
                wf_logf(WF_INFO, "wprot: %s (mounted=%s server=%s uploader=%s hd=%s)",
                        wprot ? "ASSERTED -- the Amiga cannot write" : "RELEASED -- the Amiga may write",
                        mounted ? "yes" : "no",
                        mounted ? (c.mounted_write_protected ? "protected" : "writable") : "n/a",
                        up_forced ? "forced" : "ok",
                        hd_mounted ? "read-only" : "no");
```

In core0's swap block, replace `verify_next = now_mounted ? 0 : NUM_TRACKS;   // sweep on mount only` with:

```c
            // Sweep on mount only, and not an HD disk: its slot holds ADF,
            // which psram_image_read refuses; its encode is host-tested
            // against Greaseweazle (test_track_cache_hd.c).
            verify_next = now_mounted &&
                psram_image_slot_kind(psram_token_slot(last_active_token)) != SLOT_KIND_ADF_HD
                ? 0 : NUM_TRACKS;
```

- [ ] **Step 6: Build the release and the verify-tracks variant**

```bash
pnpm firmware:build 2>&1 | tail -3
cmake -S wifi-floppy/firmware -B "${TMPDIR:-/tmp}/wf-build-verify" -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk \
  -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_VERIFY_TRACKS=ON >/dev/null && cmake --build "${TMPDIR:-/tmp}/wf-build-verify" 2>&1 | tail -3
```

Expected: both build cleanly.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/write_back.h wifi-floppy/firmware/src/write_back.c \
  wifi-floppy/firmware/test/test_write_back.c wifi-floppy/firmware/src/main.c
git commit -F- <<'EOF'
firmware: an HD disk asserts WPROT whatever the server says, and a captured write to it is discarded

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 9: Firmware — the drive-ID responder (phase fixed), `WF_DRIVE_ID`, `playsHd`

**Files:**
- Create (starting from the spike's, then changed as below): `wifi-floppy/firmware/src/drive_id.h`, `wifi-floppy/firmware/src/drive_id.c`, `wifi-floppy/firmware/test/test_drive_id.c`
- Modify: `wifi-floppy/firmware/src/floppy.pio` (a new program before `% c-sdk {`, and a new init function inside it)
- Modify: `wifi-floppy/firmware/src/bus_out.h`, `wifi-floppy/firmware/src/bus_out.c`
- Modify: `wifi-floppy/firmware/src/main.c` (include; PIO setup after `sel_mtr` :2058; swap block :2226-2236; core1 after `dc_init` :1306-1308)
- Modify: `wifi-floppy/firmware/src/device_client.h` (:285-286 struct, :478 decl), `wifi-floppy/firmware/src/device_client.c` (:1071-1090 body, :1302 setter)
- Modify: `wifi-floppy/firmware/test/test_device_client.c`
- Modify: `wifi-floppy/firmware/src/dskchg.c:16-22` (comment)
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (add `src/drive_id.c`; the `WF_DRIVE_ID` option after `WF_BUS_SNIFF`)

**Interfaces:**
- Consumes: `psram_image_slot_kind`, `SLOT_KIND_ADF_HD` (Task 6).
- Produces:
  - `drive_id.h`: `DRIVE_ID_DD 0xFFFFFFFFu`, `DRIVE_ID_HD 0xAAAAAAAAu`, `drive_id_model_t`, `drive_id_model_init/set_id/select/deselect/level`, `bool drive_id_model_rdy_gpio(const drive_id_model_t *)`, `uint32_t drive_id_for(bool hd_mounted)`.
  - `bus_out.h` (only with `WF_DRIVE_ID`): `void bus_out_drive_id_init(PIO pio)`, `bool bus_out_drive_id_set_hd(bool hd)`.
  - `device_client.h`: `void dc_set_plays_hd(device_client_t *c, bool on)`; when on, the status body carries `,"playsHd":true`.

**The phase, stated once** (the spec's §5.4, and the bench's finding). The spike's program put bit 31 on the reset select. On the wire, logical `0xAAAAAAAA` then read as an invalid ID, while `0x55555555` read as HD. The Amiga ignores the reset select and samples the 32 selects after it. The fix is in the program, not the word: the reset select answers **nothing** (RDY stays released), and bit 31 goes out on the next motor-off select. The host model in `drive_id.c` is the reference. The PIO below is written to match it instruction by instruction, and each model line names the instruction it stands for.

- [ ] **Step 1: Write the model's tests**

Create `wifi-floppy/firmware/test/test_drive_id.c`:

```c
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "drive_id|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_drive_id.c` (`../src/drive_id.h` does not exist yet).

- [ ] **Step 3: The model**

Create `wifi-floppy/firmware/src/drive_id.h`:

```c
#ifndef DRIVE_ID_H
#define DRIVE_ID_H
// ---------------------------------------------------------------------------
// Amiga drive-ID answer: the pure half (HD spec 2026-09-26 §5.4).
//
// The timing lives in PIO (floppy.pio: drive_id, answering on RDY from pio0).
// What that program DOES, select by select, is modelled here so the protocol
// is host-tested; each model line names the instruction it stands for, and
// the program is changed only together with this model.
//
//  * Only SEL0 is looked at: a select of another drive changes nothing, and
//    RDY is released whenever SEL0 is (the SEL0 gating rule, HANDOFF 4e), so
//    a real drive on DF1 is untouched.
//  * MTR is latched on each SEL0 fall, as a real drive (and sel_mtr) does.
//  * Motor latched ON: RDY is the CPU's level (dskchg: spun up + disk in).
//  * Motor latched OFF: the FIRST such select after a motor-on one (or after
//    power-up) is the RESET. It reloads the ID and answers NOTHING: RDY
//    stays released. Every motor-off select after it answers the next bit,
//    MSB first, 1 = RDY asserted. After 32 the pattern repeats seamlessly.
//
// Why that phase: measured on the bench 2026-09-26 (HANDOFF, HD spike). With
// the reset carrying bit 31 -- the spike's program, and FlashFloppy's reading
// of it -- the logical HD ID read as an invalid one, and 0x55555555 on the
// wire read as HD. So Kickstart does not sample the reset select.
//
// Polarity: "asserted" is GPIO 12 HIGH, which through the BSS138 pulls /RDY
// LOW (floppy_io.h, bus_gate.c); the Amiga counts /RDY low as a 1 bit, so a
// DD drive (RDY asserted on every ID select) reads 0xFFFFFFFF.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

#define DRIVE_ID_DD    0xFFFFFFFFu   // 3.5" DD
#define DRIVE_ID_HD    0xAAAAAAAAu   // 3.5" HD (with HD media in)

typedef struct {
    uint32_t id;           // what the next load takes
    uint32_t shifter;      // OSR
    unsigned bits_left;    // 32 - OSR's shift count
    bool     motor_on;     // latched at the last SEL0 fall; true at power-up
    bool     selected;
    bool     level;        // the CPU's RDY level (X)
    bool     rdy;          // RDY asserted (GPIO high) right now
} drive_id_model_t;

void drive_id_model_init(drive_id_model_t *m, uint32_t id);
// The CPU changes the ID (bus_out_drive_id_set_hd rewrites the two loads):
// taken at the next load -- the next reset, or the 32-bit repeat.
void drive_id_model_set_id(drive_id_model_t *m, uint32_t id);
// SEL0 falls with MTR as given (true = motor requested, bus line low).
void drive_id_model_select(drive_id_model_t *m, bool mtr_on);
void drive_id_model_deselect(drive_id_model_t *m);
void drive_id_model_level(drive_id_model_t *m, bool assert);
// The level the program drives on GPIO 12: true = high = /RDY low on the bus.
bool drive_id_model_rdy_gpio(const drive_id_model_t *m);

// The ID the board answers: HD while an HD (ADF_HD) disk is mounted; DD for a
// DD disk, an HFE, or no disk (spec §5.4).
uint32_t drive_id_for(bool hd_mounted);

#endif
```

Create `wifi-floppy/firmware/src/drive_id.c`:

```c
#include "drive_id.h"

// Each function is one path through floppy.pio's drive_id program; the
// comments name the instructions they stand for.

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

uint32_t drive_id_for(bool hd_mounted) {
    return hd_mounted ? DRIVE_ID_HD : DRIVE_ID_DD;
}
```

- [ ] **Step 4: Run the model tests**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_drive_id|FAIL|COMPILE"`
Expected: `test_drive_id.c: … checks, 0 failed`.

- [ ] **Step 5: The PIO program, matching the model**

In `wifi-floppy/firmware/src/floppy.pio`, directly before the line `% c-sdk {`, add:

```
; ---------------------------------------------------------------------------
; drive_id: RDY, with the Amiga drive-ID answer (HD spec 2026-09-26 §5.4).
; Model and protocol: drive_id.h, tested select by select in
; test/test_drive_id.c -- change this program only together with that model.
;
; Runs on pio0, which is handed the RDY pad instead of pio1 (status_gate
; still writes GP12 in its window, but a pad listens to one PIO only):
;   SEL0 falls, MTR latched ON  -> RDY = X, the CPU's level (status_gate's job)
;   SEL0 falls, MTR latched OFF -> the first time after motor-on: the RESET --
;                                 load the ID, answer nothing (RDY released);
;                                 after that: the next ID bit, MSB first,
;                                 1 = asserted; after 32 the pattern repeats
; The bit is on the pad ~60 ns after SEL0 falls; the old GPIO-ISR shifter
; caught 0 of Kickstart's 33 selects (1-4 us each).
;
; X = the CPU's RDY level, written ONLY by an exec'd `set x` (bus_out.c) --
; never through the TX FIFO, which this program reads only while selected
; with the motor on, so levels set in between would pile up and, past eight,
; be dropped newest-first. ISR = DRIVE_ID_HD, loaded once at init.
; reset_load and repeat_load are REWRITTEN by bus_out_drive_id_set_hd():
; `mov osr, isr` (HD) or `mov osr, ~null` (DD, all ones). OSR = the shifter
; (shift left, OSRE after 32). Y = scratch. out pins = RDY (1), jmp_pin =
; SEL0, in_base = MTR with in_count 1 (RP2350: `mov y, pins` sees MTR alone).
; SEL0 is GP2, literally: `wait gpio` takes a number, and bus_out.c asserts
; PIN_SEL0 == 2. 16 instructions: pio0 then holds flux_out 8 + flux_in 7 +
; this 16 = 31 of 32.
; ---------------------------------------------------------------------------
.program drive_id
public on_released:           ; deselected; motor latched ON (or power-up)
    mov pins, null            ; RDY released
    wait 0 gpio 2 [7]         ; SEL0 falls; ~53 ns for MTR, as sel_mtr waits
    mov y, pins               ; MTR: 1 = high = motor off
    jmp !y, on_selected       ; motor on: RDY is the CPU's level
public reset_load:            ; THE RESET: first motor-off select after motor-on
    mov osr, isr              ; load the ID (rewritten: isr = HD, ~null = DD)
    jmp bit_done              ; ...and answer nothing: RDY stays released
id_bit:
    out pins, 1               ; this select's bit on RDY, MSB first
bit_done:
    wait 1 gpio 2             ; SEL0 released
    mov pins, null
    jmp !osre, off_wait       ; bits left in this answer
public repeat_load:
    mov osr, isr              ; all 32 sent: the pattern repeats (rewritten too)
off_wait:                     ; deselected; motor latched OFF
    wait 0 gpio 2 [7]
    mov y, pins
    jmp y--, id_bit           ; still off (y was 1): the next bit
.wrap_target
on_selected:                  ; selected, motor on
    mov pins, x
    jmp pin, on_released      ; SEL0 high: deselected
.wrap

```

Inside the `% c-sdk { … %}` block, before its closing `%}`, add:

```c
static inline void drive_id_program_init(PIO pio, uint sm, uint offset, uint rdy_pin,
                                         uint mtr_pin, uint sel0_pin, uint32_t hd_id) {
    pio_sm_config c = drive_id_program_get_default_config(offset);
    sm_config_set_out_pins(&c, rdy_pin, 1);
    sm_config_set_in_pin_base(&c, mtr_pin);
    sm_config_set_in_pin_count(&c, 1);                   // mov y, pins = MTR alone
    sm_config_set_jmp_pin(&c, sel0_pin);
    sm_config_set_out_shift(&c, false, false, 32);       // MSB first; OSRE after 32
    sm_config_set_clkdiv(&c, 1.0f);
    pio_sm_set_pins_with_mask(pio, sm, 0, 1u << rdy_pin);            // released
    pio_sm_set_pindirs_with_mask(pio, sm, 1u << rdy_pin, 1u << rdy_pin);
    pio_sm_init(pio, sm, offset + drive_id_offset_on_released, &c);
    // ISR = the HD word, for the loads that name it; X = 0 (released) until
    // bus_out.c sets the real level. Both before the machine runs.
    pio_sm_put(pio, sm, hd_id);
    pio_sm_exec(pio, sm, pio_encode_pull(false, true));
    pio_sm_exec(pio, sm, pio_encode_mov(pio_isr, pio_osr));
    pio_sm_exec(pio, sm, pio_encode_set(pio_x, 0));
}
```

- [ ] **Step 6: bus_out — hand RDY over, forward the level by exec, rewrite the loads**

Replace `wifi-floppy/firmware/src/bus_out.h`'s block from `void bus_out_set(unsigned pin, bool assert);` to the final `#endif` with:

```c
void bus_out_set(unsigned pin, bool assert);

// CMake passes WF_DRIVE_ID=0 or 1 (option WF_DRIVE_ID, default ON). The
// fallback is the conservative one: no responder.
#ifndef WF_DRIVE_ID
#define WF_DRIVE_ID 0
#endif

#if WF_DRIVE_ID
// Hands RDY to floppy.pio's drive_id program on `pio`, which answers the
// Amiga's drive-ID read on DF0's motor-off selects (drive_id.h, HD spec
// §5.4). Answers DD until bus_out_drive_id_set_hd(true). bus_out_set(PIN_RDY,
// ...) keeps working: the level goes to drive_id. Call once on core0, after
// bus_out_init.
void bus_out_drive_id_init(PIO pio);
// Answer HD (true) or DD (false) from the next answer on -- never mid-answer.
// Core0 only. True if it changed.
bool bus_out_drive_id_set_hd(bool hd);
#endif

#endif
```

In `wifi-floppy/firmware/src/bus_out.c`: after `static uint32_t     shadow;` add:

```c

#if WF_DRIVE_ID
#include "drive_id.h"
// RDY belongs to drive_id (floppy.pio) once bus_out_drive_id_init has run.
// The CPU's level reaches it as X, by an exec'd `set x` -- see the program's
// header for why never through its FIFO.
static PIO  id_pio;
static uint id_off;
static int  id_sm = -1;            // written under gate_lock, before the machine runs
static bool id_hd;
_Static_assert(PIN_SEL0 == 2, "floppy.pio's drive_id waits on GP2 literally");

// The two loads name the ID: `mov osr, isr` for HD (ISR holds DRIVE_ID_HD
// from init) or `mov osr, ~null` for DD's all-ones. A rewritten instruction
// takes effect at its next fetch, and a load runs only at the start of an
// answer (the reset, or the 32-bit repeat), so a change never lands
// mid-answer -- drive_id.h's model, test_drive_id.c's
// an_id_change_waits_for_the_next_answer.
static void id_write_loads(bool hd) {
    const uint load = hd ? pio_encode_mov(pio_osr, pio_isr)
                         : pio_encode_mov_not(pio_osr, pio_null);
    id_pio->instr_mem[id_off + drive_id_offset_reset_load]  = load;
    id_pio->instr_mem[id_off + drive_id_offset_repeat_load] = load;
}
#endif
```

In `bus_out_set`, replace

```c
    if (next != shadow) {
        shadow = next;
        // The machine pulls every ~33 ns, so the 8-deep FIFO cannot fill
        // from here; pushing under the lock keeps the words in order.
        pio_sm_put(gate_pio, gate_sm, next);
    }
```

with

```c
    if (next != shadow) {
        const uint32_t was = shadow;
        shadow = next;
        // The machine pulls every ~33 ns, so the 8-deep FIFO cannot fill
        // from here; pushing under the lock keeps the words in order.
        pio_sm_put(gate_pio, gate_sm, next);
#if WF_DRIVE_ID
        // RDY's pad is drive_id's: give it the level too. One register write.
        if (id_sm >= 0 && ((next ^ was) & (1u << PIN_RDY)))
            pio_sm_exec(id_pio, (uint)id_sm, pio_encode_set(pio_x, (next >> PIN_RDY) & 1u));
#endif
    }
```

At the end of the file add:

```c

#if WF_DRIVE_ID
void bus_out_drive_id_init(PIO pio) {
    uint off = (uint)pio_add_program(pio, &drive_id_program);
    uint sm  = (uint)pio_claim_unused_sm(pio, true);
    drive_id_program_init(pio, sm, off, PIN_RDY, PIN_MTR, PIN_SEL0, DRIVE_ID_HD);
    uint32_t save = spin_lock_blocking(gate_lock);
    id_pio = pio;
    id_off = off;
    id_hd  = false;
    id_write_loads(false);                              // DD until a disk says otherwise
    pio_sm_exec(pio, sm, pio_encode_set(pio_x, (shadow >> PIN_RDY) & 1u));   // today's level first
    id_sm  = (int)sm;
    pio_sm_set_enabled(pio, sm, true);
    pio_gpio_init(pio, PIN_RDY);                        // the pad leaves pio1 last
    spin_unlock(gate_lock, save);
}

bool bus_out_drive_id_set_hd(bool hd) {
    if (id_sm < 0 || hd == id_hd) return false;
    id_hd = hd;
    id_write_loads(hd);
    return true;
}
#endif
```

- [ ] **Step 7: `playsHd` in the status report**

Write the failing test first. Append to `wifi-floppy/firmware/test/test_device_client.c` before `int main`:

```c
// HD spec §5.5: "playsHd":true only from a build with the drive-ID responder
// (main.c sets it from WF_DRIVE_ID); otherwise no key at all, which the
// server reads as "cannot play HD".
static void test_status_reports_plays_hd_only_when_set(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.4.0+gabc1234");
    CHECK(strstr(fake_last_request(), "playsHd") == NULL, "not set: no key");

    dc_set_plays_hd(&c, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.4.0+gabc1234");
    CHECK(strstr(fake_last_request(), "\"playsHd\":true") != NULL, "set: says so");
}
```

Add `RUN(test_status_reports_plays_hd_only_when_set);` to `main`. In `test_status_body_fits_at_maximum`, after `dc_set_nfc_reader(&c, "present");` add `dc_set_plays_hd(&c, true);`, and after its last `CHECK` add:

```c
    CHECK(strstr(r, "\"playsHd\":true") != NULL, "playsHd survives a maximal body");
```

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "device_client|COMPILE FAIL"`. Expected: `COMPILE FAIL: test_device_client.c` (`dc_set_plays_hd` undeclared).

In `wifi-floppy/firmware/src/device_client.h`, after the `char     _nfc_reader[8];` member add:

```c
    // dc_set_plays_hd: "playsHd":true in every status report.
    bool     _plays_hd;
```

and after the `dc_set_nfc_reader` declaration add:

```c

// Whether dc_report_status says "playsHd":true (HD spec §4.3, §5.5). main.c
// sets it once from WF_DRIVE_ID: the drive-ID responder is what lets the
// Amiga read an HD disk as HD. False (dc_init's zero) omits the key -- the
// shape older firmware sends, which the server reads as "cannot play HD".
void dc_set_plays_hd(device_client_t *c, bool on);
```

In `wifi-floppy/firmware/src/device_client.c`, in `dc_report_status`, change the body `snprintf` to:

```c
    int body_len = snprintf(body, sizeof body,
        "{\"mountedSha256\":%s,\"mountedDiskId\":%s,\"version\":%lu,"
        "\"error\":%s,\"psramFree\":%d,\"firmwareVersion\":%s,\"rssi\":%d,"
        "\"trackMaxBytes\":%u%s%s%s}",
        sha_field, disk_field, (unsigned long)c->mounted_version,
        err_field, psram_free, ver_field, rssi, (unsigned)TRACK_MAX_BYTES, fw_tail, nfc_tail,
        // playsHd: only from a build with the drive-ID responder (HD spec §5.5).
        c->_plays_hd ? ",\"playsHd\":true" : "");
```

and after `dc_set_nfc_reader`'s definition add:

```c

void dc_set_plays_hd(device_client_t *c, bool on) {
    c->_plays_hd = on;
}
```

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -40`
Expected: every file 0 failed, including `test_device_client.c` and `test_drive_id.c`. `,"playsHd":true` adds 15 bytes to the worst-case body. If `test_status_body_fits_at_maximum` now fails, raise `DC_STATUS_BODY_BYTES` to 1152 and `DC_STATUS_REQ_BYTES` to 1664 in `device_client.h`, adding one sentence to the comment above them ("+15 for playsHd, HD spec §5.5"). Do not shorten any other field.

- [ ] **Step 8: Wire it in main.c, the CMake option, and the dskchg note**

`wifi-floppy/firmware/src/main.c`: add `#include "drive_id.h"` after `#include "bus_out.h"`. After `pio_sm_set_enabled(bus_pio, mtr_sm, true);` (the `sel_mtr` setup) add:

```c

#if WF_DRIVE_ID
    // The Amiga drive-ID answer on RDY (HD spec §5.4). pio0, beside flux_out
    // and flux_in: 31 of its 32 instruction slots.
    bus_out_drive_id_init(pio);
    wf_logf(WF_INFO, "drive-id: answering DD 0x%08lx on DF0 motor-off selects",
            (unsigned long)DRIVE_ID_DD);
#endif
```

In the swap block, replace

```c
            if (now_mounted) {
                dskchg_image_inserted();
                wf_trace(WF_EV_MOUNT, (uint32_t)last_active_token, 0);
            } else {
                dskchg_image_ejected();
```

with

```c
            if (now_mounted) {
#if WF_DRIVE_ID
                // Before the insert is announced, so an ID read the change
                // prompts sees the new disk's density. Taken at the next
                // answer, never mid-answer (bus_out.c). Whether Kickstart
                // re-reads the ID on a change at all is bench step 9.
                const bool hd = psram_image_slot_kind(psram_token_slot(last_active_token))
                                == SLOT_KIND_ADF_HD;
                if (bus_out_drive_id_set_hd(hd))
                    wf_logf(WF_INFO, "drive-id: now answering %s 0x%08lx",
                            hd ? "HD" : "DD", (unsigned long)drive_id_for(hd));
#endif
                dskchg_image_inserted();
                wf_trace(WF_EV_MOUNT, (uint32_t)last_active_token, 0);
            } else {
#if WF_DRIVE_ID
                if (bus_out_drive_id_set_hd(false))
                    wf_logf(WF_INFO, "drive-id: now answering DD 0x%08lx (no disk)",
                            (unsigned long)DRIVE_ID_DD);
#endif
                dskchg_image_ejected();
```

In core1, after `dc_set_observer(&c, ui_observe, NULL);` (the line following `dc_init(&c, …)`) add:

```c
        // HD spec §5.5: this build can play HD only if the drive-ID responder
        // is in it. After dc_init, which zeroes the struct.
        dc_set_plays_hd(&c, WF_DRIVE_ID != 0);
```

`wifi-floppy/firmware/CMakeLists.txt`: in `add_executable`, change `src/bus_gate.c src/bus_out.c` to `src/bus_gate.c src/bus_out.c src/drive_id.c`. After the `WF_BUS_SNIFF` block's `endif ()` add:

```cmake
# The Amiga drive-ID answer on RDY (floppy.pio drive_id, drive_id.h): what
# lets the Amiga read an HD disk as HD (spec 2026-09-26-hd-floppies §5.4).
# ON for every release. OFF is the kill switch: no responder -- RDY released
# through the ID read, as before 1.4.0 -- and the board stops reporting
# playsHd, so the server refuses HD mounts cleanly.
option(WF_DRIVE_ID "Answer the Amiga drive-ID read on RDY (needed for HD disks)" ON)
if (WF_DRIVE_ID)
  target_compile_definitions(wifi_floppy PRIVATE WF_DRIVE_ID=1)
else ()
  target_compile_definitions(wifi_floppy PRIVATE WF_DRIVE_ID=0)
  message(STATUS "WF_DRIVE_ID is OFF: no drive-ID answer; the server will refuse HD disks.")
endif ()
```

`wifi-floppy/firmware/src/dskchg.c`: replace the paragraph from `// NO AMIGA DRIVE-ID ANSWER, deliberately.` through `// it would need something as fast as the select; nothing measured needs it.` with:

```c
// NO AMIGA DRIVE-ID ANSWER HERE. This file used to clock ID_3_5_DD out on
// /RDY from the SEL0 interrupt. Measured 2026-09-15 (HANDOFF §4d): Kickstart
// reads DF0's ID at power-on -- 33 selects in ~141 us, each held 1-4 us --
// and the interrupt caught 0 of them. The answer now comes from PIO
// (floppy.pio drive_id, drive_id.h; HD spec §5.4), when built with
// WF_DRIVE_ID. This file is unchanged by that: its RDY level still goes
// through bus_out_set(), which forwards it to drive_id.
```

- [ ] **Step 9: Build both variants and check pio0's instruction budget**

```bash
pnpm firmware:build 2>&1 | tail -3
grep -E "^static const struct pio_program (flux_out|flux_in|drive_id)_program|\.length = " \
  wifi-floppy/firmware/build/floppy.pio.h
cmake -S wifi-floppy/firmware -B "${TMPDIR:-/tmp}/wf-build-noid" -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk \
  -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_DRIVE_ID=OFF >/dev/null && cmake --build "${TMPDIR:-/tmp}/wf-build-noid" 2>&1 | tail -3
```

Expected: both builds are clean. In the `.length` lines, flux_out + flux_in + drive_id is **≤ 32**, and should be 8 + 7 + 16 = 31. If the sum exceeds 32, `pio_add_program` panics at boot. Stop and report; do not move the program without the controller's word. (The `floppy.pio.h` path can differ; `find wifi-floppy/firmware/build -name floppy.pio.h`.)

- [ ] **Step 10: Run the whole host suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -45; echo "exit=$?"`
Expected: every file reports 0 failed, `exit=0`, and neither the `gpio_put on a PIO-owned bus output` guard nor the `XIP_BASE` guard fires.

- [ ] **Step 11: Commit**

```bash
git add wifi-floppy/firmware/src/drive_id.h wifi-floppy/firmware/src/drive_id.c wifi-floppy/firmware/test/test_drive_id.c \
  wifi-floppy/firmware/src/floppy.pio wifi-floppy/firmware/src/bus_out.h wifi-floppy/firmware/src/bus_out.c \
  wifi-floppy/firmware/src/main.c wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c \
  wifi-floppy/firmware/test/test_device_client.c wifi-floppy/firmware/src/dskchg.c wifi-floppy/firmware/CMakeLists.txt
git commit -F- <<'EOF'
firmware: PIO drive-ID answer on RDY, phase fixed (the reset select carries no bit); playsHd

HD while an HD disk is mounted, DD otherwise; the word changes only at
the start of an answer. RDY's level reaches the program by an exec'd
`set x`, not its FIFO. WF_DRIVE_ID=OFF removes it and the playsHd claim.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 10: Bench prep — a bootable HD Workbench test disk

**Files:**
- Create: `scripts/hd-test-disk.sh`

**Interfaces:**
- Consumes: `xdftool` (amitools 0.4, at `/opt/homebrew/bin/xdftool`).
- Produces: `scripts/hd-test-disk.sh <workbench-dd.adf> <out-dir>`, which writes `<out-dir>/HDBench.adf` (1,802,240 bytes, FFS, bootable, root block 1760) and `<out-dir>/HDCheck.txt`, and prints the check file's sha-256. It refuses an output directory inside the repository, and it neither commits nor fetches any disk image.

xdftool 0.4 creates only DD `.adf` images. `xdftool x.adf create size=1760Ki` still makes 901,120 bytes (checked while planning). So the script makes a raw `.hdf` with geometry `chs=80,2,22` (the same byte layout as an HD ADF) and renames it. Checked while planning: `xdftool hd.hdf create chs=80,2,22 + format HDTest ffs + boot install` gives 1,802,240 bytes, "root_blk: 1760 (got 1760)" and "bootable: True".

- [ ] **Step 1: Write the script**

Create `scripts/hd-test-disk.sh` (and `chmod +x` it):

```bash
#!/usr/bin/env bash
# Bench prep for HD (spec 2026-09-26-hd-floppies §7 "Test disk"): a bootable
# 1.76 MB FFS HD ADF with everything on a DD Workbench disk, plus one known
# file. The DD ADF is an ARGUMENT -- no disk image is committed or fetched
# here -- and the output goes outside the repository.
#
#   scripts/hd-test-disk.sh <workbench-dd.adf> <out-dir>
#
# amitools 0.4's xdftool makes only DD .adf images, so the HD image is made as
# a raw .hdf of 80 cylinders x 2 heads x 22 sectors -- byte for byte an HD
# ADF's layout -- and renamed. xdftool puts the root block at 1760, where an
# HD boot block points.
#
# The known file, HDCheck.txt, is 20,000 numbered lines (560,000 bytes).
# Workbench 3.1 has no checksum tool, so on the Amiga:
#   Copy HDBench:HDCheck.txt RAM:      -- no error
#   List RAM:HDCheck.txt               -- 560000 bytes
#   Type RAM:HDCheck.txt               -- ends "HDCHECK line 20000 of 20000"
# trackdisk checks every sector's MFM data checksum as it reads, so a bad
# sector fails the Copy instead of passing silently.
set -euo pipefail
usage='usage: scripts/hd-test-disk.sh <workbench-dd.adf> <out-dir>'
src=${1:?$usage}
out=${2:?$usage}

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
mkdir -p "$out"
out=$(cd "$out" && pwd)
case "$out/" in
  "$repo"/*) echo "refusing to write inside the repository: $out" >&2; exit 1 ;;
esac
[ "$(wc -c < "$src" | tr -d ' ')" = 901120 ] || { echo "$src is not a 901,120-byte DD ADF" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 1. The DD disk's files, as a tree (xdftool names the directory after the volume).
mkdir "$work/unp"
xdftool "$src" unpack "$work/unp" >/dev/null
vol_dir=$(find "$work/unp" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$vol_dir" ] || { echo "no volume unpacked from $src" >&2; exit 1; }
vol=$(basename "$vol_dir")   # keep the name: Workbench's own files may refer to it

# 2. The known file.
awk 'BEGIN { for (i = 1; i <= 20000; i++) printf "HDCHECK line %05d of 20000\n", i }' > "$work/HDCheck.txt"
[ "$(wc -c < "$work/HDCheck.txt" | tr -d ' ')" = 560000 ]

# 3. The HD image: format, boot block, the tree, the known file.
hdf="$work/HDBench.hdf"
xdftool "$hdf" create chs=80,2,22 + format "$vol" ffs + boot install >/dev/null
find "$vol_dir" -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d '' entry; do
  xdftool "$hdf" write "$entry" >/dev/null
done
xdftool "$hdf" write "$work/HDCheck.txt" >/dev/null

[ "$(wc -c < "$hdf" | tr -d ' ')" = 1802240 ] || { echo "image is not 1,802,240 bytes" >&2; exit 1; }
xdftool "$hdf" boot show | grep -q 'root_blk:  1760' || { echo "root block is not 1760" >&2; exit 1; }
xdftool "$hdf" boot show | grep -q 'bootable: True'  || { echo "boot block is not bootable" >&2; exit 1; }

cp "$hdf" "$out/HDBench.adf"
cp "$work/HDCheck.txt" "$out/HDCheck.txt"
echo "wrote $out/HDBench.adf (volume \"$vol\", FFS, 1,802,240 bytes)"
echo "HDCheck.txt: 560000 bytes, sha256 $(shasum -a 256 "$work/HDCheck.txt" | cut -d' ' -f1)"
xdftool "$hdf" info
```

- [ ] **Step 2: Try it on a synthetic DD disk (no real image involved)**

```bash
S="${TMPDIR:-/tmp}/hd-test-disk-check"; rm -rf "$S"; mkdir -p "$S"
printf 'echo "hello from S:Startup-Sequence"\n' > "$S/ss"
xdftool "$S/src.adf" format DDSrc ffs + makedir S + write "$S/ss" S/Startup-Sequence + boot install >/dev/null
scripts/hd-test-disk.sh "$S/src.adf" "$S/out"
xdftool "$S/out/HDBench.adf" list 2>&1 | head -3 || true    # expected to fail: xdftool opens .adf as DD only
cp "$S/out/HDBench.adf" "$S/check.hdf" && xdftool "$S/check.hdf" list
scripts/hd-test-disk.sh "$S/src.adf" ./inside-repo; echo "exit=$?"
```

Expected:
- The first run prints `wrote …/HDBench.adf (volume "DDSrc", …)`, the sha-256 line, and `info` showing total `3520 … 1802240`.
- Listing `check.hdf` shows `S/Startup-Sequence` and `HDCheck.txt  560000`.
- The last run prints `refusing to write inside the repository` with `exit=1`. Remove any `./inside-repo` directory the `mkdir -p` created (`rmdir inside-repo`).

- [ ] **Step 3: Commit**

```bash
git add scripts/hd-test-disk.sh
git commit -F- <<'EOF'
scripts: hd-test-disk.sh builds a bootable 1.76 MB FFS Workbench disk from a DD one, for the HD bench

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 11: Firmware 1.4.0, docs, and the bench checklist

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt:151` (semver)
- Modify: `README.md` (Features: Library, The drive; How it works; Status table)
- Modify: `HANDOFF.md` (the "Where things stand" table; backlog entry "HD floppies -- 2026-09-26 SPIKE DONE" at ~:2082; a new section `### 3an. HD floppies, read-only` placed directly before `### 3am.`)

**Interfaces:**
- Consumes: everything above.
- Produces: a 1.4.0 build in `wifi-floppy/firmware/build/` (the controller publishes it and flashes the board), and the bench checklist the operator runs.

- [ ] **Step 1: Bump the version and build the release**

In `wifi-floppy/firmware/CMakeLists.txt` change `set(FIRMWARE_SEMVER "1.3.1")` to `set(FIRMWARE_SEMVER "1.4.0")`. Then:

```bash
pnpm firmware:build 2>&1 | tail -3
grep WF_FIRMWARE_VERSION wifi-floppy/firmware/build/generated/wifi_floppy_version.h
wifi-floppy/firmware/test/run.sh 2>&1 | tail -3; echo "exit=$?"
```

Expected: a clean build, a version string starting `1.4.0+g`, and `exit=0`. (A `-dirty` suffix is expected until this commit is made. The controller builds again from the committed tree before publishing.)

- [ ] **Step 2: README**

In `README.md`:
- In the intro bullet, change `behaves like a DD floppy drive, and plays whichever disk you pick in the web app.` to `behaves like a floppy drive (DD, and HD read-only), and plays whichever disk you pick in the web app.`
- Under **### Library**, after the `- Upload \`.adf\`, …` bullet, add: `- HD (1.76 MB) ADFs are recognised and tagged HD. They play on the Amiga read-only; they can't be browsed or edited in the browser yet.`
- Under **### The drive**, after `- Works as DF0 or alongside a second drive as DF1.`, add: `- Plays HD disks read-only: the board tells the Amiga it is an HD drive while an HD disk is in, and asserts write protect. Needs Kickstart 3.0 or later, and firmware 1.4.0 or later (the web app refuses to mount an HD disk on older firmware and says so).`
- In **## How it works**, after the paragraph that ends `flux formats such as HFE use the same path.`, add: `An HD disk is the exception. The server sends the board the ADF itself (a small WFAD header, then 1,802,240 bytes), and the board encodes each track to MFM as the head reaches it, in about 4 ms, well inside the head's settle time. A PIO program answers the Amiga's drive-ID read on RDY with the HD ID while an HD disk is mounted.`
- In **## Status**, change `| Firmware updates from the web app | verified on hardware (current: 1.3.1) |` to `| Firmware updates from the web app | verified on hardware (current: 1.3.1; 1.4.0 built, not yet published) |`, and add a row after the HFE row: `| HD disks, read-only (Kickstart 3.0+) | built and host-tested; bench checklist owed (HANDOFF 3an) |`.

- [ ] **Step 3: HANDOFF — the section and the bench checklist**

In `HANDOFF.md`, insert directly before the line `### 3am. NFC tap-to-mount -- 2026-09-26 (spec/plan 2026-09-25-nfc-tap-to-mount)`:

````markdown
### 3an. HD floppies, read-only -- 2026-09-26 (spec/plan 2026-09-26-hd-floppies-read-only)

**STATUS: built on `feat/hd-floppies`; web e2e green; firmware 1.4.0 built and host-tested; NOT merged,
NOT published, bench checklist below owed.** Spec `docs/superpowers/specs/2026-09-26-hd-floppies-read-only-design.md`,
plan `docs/superpowers/plans/2026-09-26-hd-floppies-read-only.md`.

What it does:
- An ADF of exactly 1,802,240 bytes is HD (`adfDensity`, `src/lib/disk-format.ts`, the only place that knows).
  It is tagged HD on the game page, the library table and the upload list. It cannot be made writable, and
  the file browser says "HD disks can't be browsed in the browser yet". Every write route refuses it
  (`hd_read_only`).
- The server mounts HD only on a board that reports `playsHd` (column `devices.plays_hd`, migration 0026,
  applied as guarded SQL). Anywhere else it answers 409 `hd_unsupported`, "Update the drive's firmware to
  play HD disks". An NFC tap on such a board answers `too_long`: old firmware knows no other refusal word.
- The board gets HD as **WFAD** (16-byte header + the ADF). PSRAM slots are tagged `ADF_HD`, and
  `track_cache_get` encodes each track on read (`adf_mfm.c`) in core0's service loop -- thread mode, not an
  interrupt; the old track keeps streaming. SRAM track buffers grew to 25,344 bytes (~33 KB more).
- The drive-ID responder (`floppy.pio` drive_id on pio0, 31/32 instruction slots) answers HD `0xAAAAAAAA`
  while an HD disk is mounted and DD `0xFFFFFFFF` otherwise. **The reset select carries no bit** (the
  spike's off-by-one fix); the host model `test_drive_id.c` is the reference. `WF_DRIVE_ID=OFF` removes
  it and the `playsHd` claim.
- WPROT is asserted for HD whatever the server sends; a captured write to HD is discarded
  (`WB_REJECT_READ_ONLY`) and never uploaded.
- New log lines to read on the bench: `drive-id: answering DD …` at boot, `drive-id: now answering HD …`
  on an HD mount, `hd: track N encoded in X us (new max)`, `heap: free low-water N bytes`, and `wprot: …
  hd=read-only`.

**Bench prep (controller):**
1. Publish 1.4.0 from a clean tree (`pnpm firmware:build`, then `pnpm firmware:publish --notes "HD disks,
   read-only"`) and update the board from the web app.
2. `scripts/hd-test-disk.sh <a Workbench 3.1 DD ADF> <a scratch dir>` makes `HDBench.adf` and prints
   `HDCheck.txt`'s sha-256. Upload `HDBench.adf` to the library.
3. Also look for real HD disks already in the library: `select d.id, g.title from disks d join games g on
   g.id = d.game_id where d.image_format = 'adf' and d.size_bytes = 1802240;`. Try one not built here.
4. Before step 1 below, confirm the boot log's `pio claims:` line shows pio0 with three state machines
   claimed (flux_out, flux_in, drive_id).

**Bench checklist (each step is a visible pass or fail; one physical step per turn):**
1. DD Workbench 3.1 boots (regression; the DD ID is now answered, not left at 0).
2. A DD game loads (regression).
3. Turrican (HFE) boots (regression).
4. DF1 with the real drive works (regression: drive_id looks at SEL0 only).
5. An NFC tap mounts a DD disk (regression).
6. The HD Workbench disk boots. The log shows `drive-id: now answering HD 0xaaaaaaaa`.
7. Its Workbench window shows ~1.7 MB capacity. `Copy HDBench:HDCheck.txt RAM:` completes with no error,
   `List RAM:HDCheck.txt` shows 560000 bytes, and `Type RAM:HDCheck.txt` ends "HDCHECK line 20000 of 20000".
8. Saving anything to the HD disk gives "Disk is write protected". The log shows `wprot: ASSERTED … hd=read-only`
   and no `write: trk` upload.
9. Swap DD -> HD and HD -> DD while the Amiga runs; record whether each needs a reset (Ctrl-Amiga-Amiga).
   If one does, the follow-up (not built) is the web-app note "reset the Amiga after switching between
   DD and HD" when a disk of the other density is mounted (spec §5.4).
10. Read the lowest `heap: free low-water` line and the largest `hd: … encoded in` line; record both here.
````

In the "Where things stand" table, add a row after the NFC row:

```markdown
| **HD floppies, read-only** | 🟡 **built on `feat/hd-floppies`, not merged.** Web + firmware 1.4.0 done and tested; migration 0026 applied; bench checklist owed; see 3an |
```

In the backlog entry that begins `- **HD floppies -- 2026-09-26 SPIKE DONE ON THE BOARD`, prepend to its text: `**Superseded by 3an (the real feature, read-only).** ` and leave the rest as history.

- [ ] **Step 4: Full verification**

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit -p . && pnpm lint && pnpm build
wifi-floppy/firmware/test/run.sh 2>&1 | tail -3; echo "exit=$?"
pnpm hw:verify
```

Expected: every command succeeds. (`hw:verify` checks the KiCad project; nothing here touched it, so it passes unchanged.)

Then the **full e2e suite**, which is the operator's merge bar (MEMORY: ~370 tests). Run it in the foreground on `PORT=3100`, never beside another e2e run, and split into invocations that each finish in under 9 minutes. List the specs with `ls e2e/*.spec.ts`, then run them in groups of about 6 files:

```bash
PORT=3100 pnpm exec playwright test <group of spec files> --reporter=line
```

If a group runs past ~8 minutes, split it further next time. Record per group: files, passed, failed. For any failure, re-run that one spec alone before calling it a regression. A dirty environment (an orphaned dev server, another session's run) has twice been mistaken for a code regression here. When done, stop the dev server on 3100 by its PID only.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/CMakeLists.txt README.md HANDOFF.md
git commit -F- <<'EOF'
firmware 1.4.0: HD disks, read-only; README and HANDOFF 3an with the bench checklist

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

Report to the controller: the 1.4.0 version string, the full-e2e totals per group, and that publishing, flashing and the bench checklist are theirs.

---

## Self-review (done while writing; kept for the reviewers)

- **Spec coverage.**
  - §4.1 adfDensity: Task 1. Ingest unchanged: verified, `toAdf` passes `.adf` through at any size. TOSEC: untouched.
  - §4.2 tags: Task 4. File browser message and refusing routes: Tasks 3 and 4.
  - §4.3 isServable: Task 1. playsHd, hd_unsupported and every entry point: Task 2 (web mount, NFC) and Task 4 (toast; the chips do not mount). Forced WP: Task 2. Toggle disabled: Task 4 (row and chip). Write refusals: Task 3.
  - §4.4 WFAD and route: Task 1.
  - §5.1: Task 6.
  - §5.2: Task 7, with the interrupt-context question answered in Rulings.
  - §5.3: Task 8.
  - §5.4 PIO, phase, answer and kill switch: Task 9. Swap without reboot: bench step 9, fallback documented.
  - §5.5: Task 9.
  - §6: the rows map to Tasks 2, 6, 8 and 3, plus the Task 4 message and a README note for Kickstart < 3.0.
  - §7 web vitest: Tasks 1–3. e2e: Task 4. Firmware host: Tasks 5–9. Test disk: Task 10. Bench: Task 11.
  - §8: rollout order (web refuses HD until playsHd) and 1.4.0 (Task 11); publishing is the controller's.
- **Placeholders.** None. `<group of spec files>` in Task 11 is the grouping the step tells you to make, and the Task 10 script's `<workbench-dd.adf>` is the operator's own disk, deliberately not in the repo.
- **Type consistency.** These names are used identically everywhere: `adfDensity`, `isHdAdf`, `isHdAdfSql()`, `writeWfad`, `HD_UNSUPPORTED`, `HD_NOT_BROWSABLE`, `HD_READ_ONLY`, `tapRefusalOutcome`, `playsHd`/`plays_hd`, `SLOT_KIND_ADF_HD`, `psram_image_slot_kind`, `psram_image_track_data`, `WFAD_*`, `TRACK_BUF_BYTES`, `ADF_MFM_HD_TRACK_BITS`, `WB_REJECT_READ_ONLY`, `write_back_wprot`, `drive_id_model_*`, `drive_id_for`, `bus_out_drive_id_init(PIO)`, `bus_out_drive_id_set_hd(bool)` and `dc_set_plays_hd`.
