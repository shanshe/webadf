# HD disks: Amiga writes, full history, browser editing, blank HD disks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An HD disk (1,802,240-byte ADF) takes Amiga saves exactly as a DD disk does, keeps a full browsable and restorable history, is editable in the browser, and can be created blank — while DD behaves exactly as before.

**Architecture:** One geometry value `{ blockCount, rootBlock }`, derived from the image length, replaces adffs's fixed 1,760/880; the history and write-back code take the sector and track size from the image (1,760/3,520 sectors, 5,632/11,264 bytes a track) and refuse to mix sizes. The web's HD read-only refusals are removed. On the board, the capture window and buffer grow to hold one HD write, the decoder is told the mounted disk's sector count (11 or 22) and never infers it, a verified HD track is stored as ADF bytes straight into its `ADF_HD` slot, the uploader posts those bytes without re-decoding, and WPROT follows the server's flag for HD too. Firmware 1.5.0.

**Tech Stack:** Next.js 16 (App Router), Drizzle + Neon Postgres, Vercel Blob, vitest, Playwright; RP2350 firmware in C (pico-sdk 2.3.0), host-tested with `wifi-floppy/firmware/test/run.sh`; xdftool (amitools 0.4.0) as the independent filesystem oracle; Greaseweazle's AmigaDOS_HD codec (committed fixtures in `wifi-floppy/firmware/test/fixtures/adf_mfm_hd`) as the independent MFM oracle.

**Spec:** `docs/superpowers/specs/2026-09-27-hd-writes-and-editing-design.md` (binding; read it before any task). Predecessor: `docs/superpowers/specs/2026-09-26-hd-floppies-read-only-design.md` and `docs/superpowers/plans/2026-09-26-hd-floppies-read-only.md` (HANDOFF §3an: 1.4.1 verified on hardware).

## Global Constraints

- **HD rule (unchanged):** an HD disk is a row with `imageFormat === 'adf'` AND `sizeBytes === 1_802_240`; DD is 901,120. `adfDensity` / `isHdAdf` in `src/lib/disk-format.ts` stay the only row-level interpretation of those sizes.
- **Geometry:** DD = 1,760 blocks, root 880, bitmap 881, boot-block root pointer 880. HD = 3,520 blocks, root 1,760, bitmap 1,761, boot-block root pointer 1,760. One bitmap block on both (it holds 4,064 bits; HD needs 3,518). `geometryOf(adf)` in `src/lib/adffs/geometry.ts` is the only adffs code that interprets an image's length; any other length stays `not-adf`.
- **Track sizes:** 160 tracks. DD 11 sectors, **5,632** bytes a track. HD 22 sectors, **11,264** bytes a track. Sector ids accepted are `0 .. nsec-1` where `nsec` is **the mounted disk's** count, never inferred from the data. A track is complete when `found == (1u << nsec) - 1`: `0x7ff` DD, `0x3fffff` HD.
- **History:** the WDLD delta format is unchanged. A version is always the same size as its disk's current image; mixing sizes is refused. No database migration.
- **Firmware numbers:** `FLUX_CAPTURE_MAX_MS` **800**; capture buffer `FLUX_CAPTURE_BUF_BYTES` **32,768** (a ruling; see below — the spec's 28,672 does not hold the write's lead gap); `DC_POST_BODY_MAX` **11,264**; firmware version **1.5.0**. The bitcell stays 2 µs (an Amiga HD drive spins at 150 rpm), so `mfm_interval_to_bits` is unchanged.
- **Copy:** `Update the drive's firmware to play HD disks` (`HD_UNSUPPORTED`) stays verbatim. `HD_NOT_BROWSABLE` and `HD_READ_ONLY` are deleted, and the reasons `hd_not_browsable` / `hd_read_only` are produced nowhere. `devices.plays_hd` and the `hd_unsupported` mount gate stay.
- **Defaults:** HD disks stay write-protected by default, like every disk. The create control's default stays DD, FFS.
- **Older boards:** a 1.4.1 board still forces WPROT for HD itself; no capability flag. Documented in HANDOFF and README only.
- **Out of scope:** HD in `.dms`, HD HFE, the mobile-friendly redesign of the create menu.
- **Repo rules:** stage explicit paths only, never `git add -A` or `git add .`, and never `git stash`. Re-check `git status` before staging: other sessions change this machine's trees. Never print, copy or commit anything under `~/.webadf/board-backups/`. No real disk image, or anything derived from one, is committed; fixtures are synthetic. Before editing a Next.js route handler read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, and before editing a page read `03-layouts-and-pages.md` (AGENTS.md: this Next.js has breaking changes). Match the surrounding code's style and comment density: comments explain *why* and cite the spec section.
- **e2e:** it runs against the **live production database**. Use `PORT=3100`, run in the **foreground**, keep every invocation under 9 minutes (split by spec file), never run two e2e runs at once, never `pkill`/`killall` by pattern, and stop only a dev-server PID you started yourself.
- **Firmware:** host tests are `wifi-floppy/firmware/test/run.sh` (= `pnpm firmware:test`); the device build is `pnpm firmware:build`. Never `pio_encode_mov(pio_osr|pio_exec, …)` (pico-sdk 2.3.0 encodes `mov pindirs`; `run.sh` has a tripwire). **No task flashes the board or publishes to the release registry**; both are the controller's.
- **Commits:** every commit message ends with these two lines as its last paragraph (use the controller's lines instead if it gives you different ones):
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
  ```

## Review Focus

1. **A track of the wrong density's size reaches the write route**: a 5,632-byte body for an HD disk (a board that swapped disks between capture and upload), or an 11,264-byte body for a DD disk. It must be `400 invalid_body`, nothing staged, never overlaid at the wrong offset. Pinned in Task 4 (e2e in `hd-disks.spec.ts` and `device-write.spec.ts`).
2. **A page still holding a DD root number edits an HD disk**: `parentBlock: 880` or `toParent: 880` sent to an HD disk. Block 880 of an HD disk is an ordinary block; the edit must be refused (`not-a-directory` / `not-found`) and the disk's bytes left unchanged. Pinned in Task 1 (vitest, `moveEntry` onto 880) and Task 5 (e2e).
3. **Filling an HD disk to its last block.** The bitmap block's padding bits past block 3,519 read as free. Allocation must never hand out block ≥ 3,520, the root (1,760) or the bitmap (1,761), and a file that does not fit must be `disk-full` with nothing allocated. Pinned in Task 1 (vitest).
4. **A big HD save and the last track.** A save changing 1,000 sectors of an HD disk is under half the disk and must stay a delta (the DD threshold would make it a snapshot); an upload of track 159 must land in the last 11,264 bytes of the image. Pinned in Task 3 (vitest) and Task 4 (e2e, track 159).
5. **Restoring across sizes.** A history whose target version and current head differ in size (only reachable by hand-edited rows or blobs) must answer `409 size_mismatch` and record nothing, never a 500 or a half-written version. Pinned in Task 3 (vitest).

## Rulings made while planning (reviewers: these are deliberate)

- **Capture buffer 32,768 bytes, not the spec's 28,672 (§4.1).** The capture holds the whole write, lead gap included, not one track. On DD the Amiga writes ~13,264 bits of gap then the sectors: 108,992 bits measured (HANDOFF §4, "a write is gap first … ending at bit 108,980 of a 108,992-bit capture"), which is why the DD buffer is 16,384 bytes for a 12,668-byte track. If the HD gap scales with the track, an HD write is ~27,250 bytes, which leaves 28,672 a 5 % margin against DD's 20 %. 32,768 restores DD's ratio for 4 KB more RAM. Bench step 3 logs the real HD capture size (`write: trk N … B`), and the HANDOFF checklist asks for it to be recorded.
- **"An 800 ms capture fits the buffer" (spec §7) is read as "a whole HD write, which the 800 ms window admits, fits".** 800 ms of flux at the densest legal pattern is 400,000 bits (50 KB); no buffer here holds that, and a WGATE held that long is not a write. Task 9 pins both halves: an HD write with a doubled DD lead gap fits without overflow, and 800 ms of flux sets `overflowed`, which the existing verdict rejects.
- **A DD disk refuses a 22-sector track through a new verdict, `WB_REJECT_DENSITY`.** Decoding an HD track with `nsec = 11` finds sectors 0–10 complete (`0x7ff`), so completeness alone would accept it. The decoder now counts checksum-good sectors whose id is `nsec` or more (`foreign_sectors`), and the verdict rejects any. It sits after the overflow check and before the partial check; the rest of the order is unchanged. An HD disk given an 11-sector track is `WB_REJECT_PARTIAL`. `WB_REJECT_READ_ONLY` is removed (Task 8).
- **`write_back_reason` takes `nsec`** so the partial reason names the count ("not all 22 sectors verified") as spec §4.2 asks.
- **The existing decoder entry points keep their DD signatures.** `mfm_decode_track` and `mfm_decode_track_r` stay 11-sector wrappers (every existing test and the verify sweep call them); `mfm_decode_track_n` (core0) and `mfm_decode_track_rn` (caller's scratch) take `nsec`. `found` becomes `uint32_t`.
- **`DC_POST_BODY_MAX` rises from 5,632 to 11,264.** The spec does not mention it, but `dc_post` refuses any body over it, so every HD upload would fail as a transport error. Costs 5.6 KB of static RAM on core1.
- **The uploader's HD read-back is a plain copy, with no checksum to catch a torn read.** It is safe for the same reason the DD path's re-send is: `up_send_track` clears the dirty flag *before* copying, and core0's store sets it again *after* its copy, so a track rewritten during an upload is always sent again (the server upserts per track); and the close re-checks `write_gen()` and the dirty flags after hashing. The copy is into core1's own static buffer, never a pointer into PSRAM handed to `dc_post`.
- **`stageTrack` order:** a body that is neither 5,632 nor 11,264 bytes is refused before any query (as today); then the mount check (unchanged, so `not_mounted` answers stay as they are); then the disk row; then the exact size for that disk's density (`400 invalid_body`). An HFE row skips the size check and reaches the existing `write_protected` refusal, so a board's handling of HFE is unchanged. Spec §5.1's "looks up the disk first" is honoured as "the size rule is decided by the disk row, before anything is staged".
- **Delta decode accepts sector indices below 3,520; `applyDelta` bounds them by the image it is applied to.** A WDLD blob does not say which disk it belongs to, so only the apply can know. The snapshot threshold is half of *the image's own* size.
- **Mixed sizes:** `buildDelta` throws `DeltaError` for images of different sizes; `restoreVersion` compares the target with the head first and answers `409 size_mismatch` (Review Focus 5).
- **The UI learns the root block from the page, not a constant.** `readVolume`'s ok result gains `rootBlock`; `FileEditProvider` takes a `rootBlock` prop and puts it in the context that `FileToolbar`, `FileTree` and `DropStaging` already read. The routes use `volume.rootBlock`. The DD constants `ROOT_BLOCK`, `BLOCK_COUNT` and `BITMAP_BLOCK` stay exported with their DD values for existing tests, e2e helpers and `synthetic.ts`.
- **xdftool and HD.** amitools 0.4.0's ADF device is DD-only: `xdftool x.adf format …` on a 1.8 MB file rewrites it as 901,120 bytes (measured 2026-09-27). Its HDF device takes the geometry from the size, and `xdftool x.hdf create chs=80,2,22 + format N ffs` writes root 1,760, bitmap 1,761, boot pointer 1,760, "total 3520, used 4" (measured). So `pnpm adffs:verify` hands HD images to xdftool under an `.hdf` name.
- **The create control gets two more menu items**, "Create HD ADF (FFS)" and "Create HD ADF (OFS)" (`create-adf-hd-ffs`, `create-adf-hd-ofs`), after the two DD ones, which stay first and unchanged. The component's own design note rules out a sticky select; four one-click items keep "the choice is part of the click". `/api/disks/create` takes `density: 'dd' | 'hd'`, default `'dd'`.
- **`WriteProtectToggle`'s `locked` prop is deleted**: HD was its only user (HFE shows a span).
- **`mountedSizeBytes` stays in `live-state.ts`** although the chips no longer read it: it is part of the SSE fingerprint and removing it is an unrelated refactor.
- **The volume header's `not-adf` copy** becomes "This image is not a standard 880 KB or 1.76 MB ADF."

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/adffs/geometry.ts` (new) | `Geometry`, `DD_GEOMETRY`, `HD_GEOMETRY`, `geometryOf`, `geometryFor`, `BITMAP_FIRST_BLOCK` |
| `src/lib/adffs/{blocks,root,index,usage,alloc,format,file,write,constants}.ts` (modify) | take the geometry instead of 1,760/880 |
| `src/lib/adffs/hd.test.ts` (new) | the HD filesystem, every operation |
| `scripts/adffs-verify.ts` (modify) | xdftool cross-check for HD, both directions |
| `src/lib/disk-history/{delta,chain,version,history,restore}.ts` (modify) + tests | size from the image; mixed sizes refused |
| `src/lib/device-write.ts` (modify) | HD track size in `stageTrack`, HD overlay in `closeSession` |
| `src/lib/mount.ts`, `src/lib/disk-write.ts`, `src/app/api/disks/[id]/route.ts`, `…/volume-name/route.ts`, `…/files/route.ts`, `…/files/batch/route.ts`, `…/files/[block]/route.ts` (modify) + tests | read-only refusals removed; root from `volume.rootBlock` |
| `src/lib/hd-messages.ts`, `src/components/disks/{file-actions,file-tree,drop-staging,volume-header}.tsx`, `src/app/(app)/disks/[id]/files/page.tsx`, `src/components/games/{disk-row,write-protect-toggle}.tsx`, `src/lib/drive-chips.ts` (modify) + test | the UI opens and edits HD |
| `src/app/api/disks/create/route.ts`, `src/components/library/create-adf.tsx`, `e2e/helpers.ts` (modify) | blank HD disks |
| `e2e/hd-disks.spec.ts`, `e2e/device-write.spec.ts`, `e2e/create-adf.spec.ts` (modify) | end to end |
| `wifi-floppy/firmware/src/mfm.{c,h}`, `write_back.{c,h}` (modify) + `test/test_mfm.c`, `test/test_write_back.c` | `nsec`, 22 sectors, verdict, reasons |
| `wifi-floppy/firmware/src/flux_bits.h`, `flux_capture.{c,h}` (modify) + `test/test_flux_bits.c` | 800 ms, 32 KB |
| `wifi-floppy/firmware/src/psram_image.{c,h}` (modify) | `psram_image_store_adf` |
| `wifi-floppy/firmware/src/uploader.c`, `device_client.h` (modify) + `test/test_uploader.c` | HD read-back, close hash, POST size |
| `wifi-floppy/firmware/src/main.c` (modify) | decode with `nsec`, WPROT without the HD term |
| `wifi-floppy/firmware/CMakeLists.txt`, `README.md`, `HANDOFF.md` (modify) | 1.5.0, docs, bench checklist |

---

### Task 1: adffs reads and writes HD geometry

**Files:**
- Create: `src/lib/adffs/geometry.ts`, `src/lib/adffs/hd.test.ts`
- Modify: `src/lib/adffs/constants.ts:6-9` (comments only), `src/lib/adffs/blocks.ts:7,18-23`, `src/lib/adffs/root.ts:3,16-28`, `src/lib/adffs/index.ts` (whole file), `src/lib/adffs/usage.ts:14-86`, `src/lib/adffs/alloc.ts:13-36,81-166`, `src/lib/adffs/format.ts:15-31,96-205`, `src/lib/adffs/file.ts:4-8,56-76`, `src/lib/adffs/write.ts:8-20,568-592,683,825`

**Interfaces:**
- Consumes: nothing new.
- Produces (every later web task relies on these names):
  - `@/lib/adffs/geometry` (also re-exported from `@/lib/adffs`): `type Geometry = Readonly<{ blockCount: number; rootBlock: number }>`, `DD_GEOMETRY` (`1760/880`), `HD_GEOMETRY` (`3520/1760`), `geometryOf(adf: Uint8Array): Geometry | null`, `geometryFor(density: 'dd' | 'hd'): Geometry`, `BITMAP_FIRST_BLOCK = 2`.
  - `readVolume(adf)` ok result gains `rootBlock: number`.
  - `formatVolume(opts)` accepts `density?: 'dd' | 'hd'` (default `'dd'`).
  - `readUsage`, `allocate`, `free`, `isFree`, `bitmapPage`, `usedBlocks`, `setVolumeName`, `addFile`, `makeDirectory`, `renameEntry`, `deleteEntry`, `moveEntry`, `applyBatch`, `readFile` all work on either geometry with unchanged signatures.

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/sfs/Devel/webadf/.claude/worktrees/hd-writes
pnpm install
cp /Users/sfs/Devel/webadf/.env.local .env.local   # secrets: never cat, echo or commit it (.gitignore covers it)
git status --short                                 # expect nothing but untracked build output, if any
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/adffs/hd.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  readVolume, readFile, readUsage, addFile, renameEntry, deleteEntry, makeDirectory,
  moveEntry, applyBatch, geometryOf, type WriteResult, type AdfEntry,
} from './index';
import { formatVolume, usedBlocks, setVolumeName } from './format';
import { allocate } from './alloc';
import { blockAt } from './blocks';
import { BLOCK_BYTES } from './constants';

// HD writes spec §6.1: the same filesystem at 3,520 blocks with the root at
// 1,760. The layout numbers here were measured from `xdftool x.hdf create
// chs=80,2,22 + format` on 2026-09-27 (root 1760, bitmap 1761, boot pointer
// 1760, 4 used, 3516 free), not derived from the code under test.

const AT = new Date(Date.UTC(2026, 8, 27, 12, 0, 0));
const HD_ROOT = 1760;
const hd = (filesystem: 'OFS' | 'FFS' = 'FFS') =>
  formatVolume({ filesystem, volumeName: 'HDBlank', now: AT, density: 'hd' });
const be32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const text = (s: string) => new TextEncoder().encode(s);

function ok(r: WriteResult): Uint8Array {
  if (!r.ok) throw new Error(`write refused: ${r.reason}`);
  return r.adf;
}

function rootEntries(adf: Uint8Array): AdfEntry[] {
  const v = readVolume(adf);
  if (!v.ok) throw new Error(`not readable: ${v.reason}`);
  return v.root;
}

function entry(entries: AdfEntry[], name: string): AdfEntry {
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`${name} not in [${entries.map((x) => x.name).join(', ')}]`);
  return e;
}

describe('geometry', () => {
  it('is decided by the image length alone', () => {
    expect(geometryOf(new Uint8Array(901_120))).toEqual({ blockCount: 1760, rootBlock: 880 });
    expect(geometryOf(new Uint8Array(1_802_240))).toEqual({ blockCount: 3520, rootBlock: 1760 });
    expect(geometryOf(new Uint8Array(1_802_240 + 512))).toBeNull();
    expect(geometryOf(new Uint8Array(0))).toBeNull();
  });

  it('lets blockAt reach every HD block and nothing past it', () => {
    const adf = new Uint8Array(1_802_240);
    expect(blockAt(adf, 3519)).not.toBeNull();
    expect(blockAt(adf, 3520)).toBeNull();
    expect(blockAt(new Uint8Array(901_120), 1760)).toBeNull();
  });
});

describe('an HD volume', () => {
  it("formats to xdftool's layout: root 1760, bitmap 1761, boot pointer 1760", () => {
    const adf = hd();
    expect(adf.length).toBe(1_802_240);
    expect(be32(adf, 8)).toBe(HD_ROOT);
    const root = HD_ROOT * BLOCK_BYTES;
    expect(be32(adf, root + 316)).toBe(1761);   // bm_pages[0]
    expect(be32(adf, root + 320)).toBe(0);      // no second bitmap block: one holds 4,064 bits
    expect(usedBlocks(adf)).toEqual([1760, 1761]);
  });

  it('reads as an empty volume whose root is block 1760', () => {
    for (const filesystem of ['OFS', 'FFS'] as const) {
      const v = readVolume(hd(filesystem));
      if (!v.ok) throw new Error(`expected ok, got ${v.reason}`);
      expect(v.rootBlock).toBe(HD_ROOT);
      expect(v.volume.name).toBe('HDBlank');
      expect(v.volume.filesystem).toBe(filesystem);
      expect(v.root).toEqual([]);
      expect(v.warnings).toEqual([]);
    }
  });

  it('reports 3,520 blocks with 4 used, as xdftool info does', () => {
    const u = readUsage(hd())!;
    expect(u.totalBlocks).toBe(3520);
    expect(u.usedBlocks).toBe(4);
    expect(u.freeBlocks).toBe(3516);
    expect(u.totalBytes).toBe(1_802_240);
  });

  it('adds, reads back, renames, moves, moves back to the root and deletes', () => {
    let adf = ok(addFile(hd(), HD_ROOT, 'HELLO.TXT', text('hello hd')));
    adf = ok(makeDirectory(adf, HD_ROOT, 'SUB'));
    const file = entry(rootEntries(adf), 'HELLO.TXT').block;
    const sub = entry(rootEntries(adf), 'SUB').block;
    expect(readFile(adf, file)!.bytes).toEqual(text('hello hd'));

    adf = ok(renameEntry(adf, HD_ROOT, file, 'RENAMED.TXT'));
    adf = ok(moveEntry(adf, HD_ROOT, file, sub));
    expect(entry(entry(rootEntries(adf), 'SUB').children, 'RENAMED.TXT').block).toBe(file);

    // Into the root: 1760 is a directory here, where the DD constant 880 is not.
    adf = ok(moveEntry(adf, sub, file, HD_ROOT));
    expect(entry(rootEntries(adf), 'RENAMED.TXT').block).toBe(file);

    adf = ok(deleteEntry(adf, HD_ROOT, file));
    adf = ok(deleteEntry(adf, HD_ROOT, sub));
    expect(rootEntries(adf)).toEqual([]);
    expect(readUsage(adf)!.usedBlocks).toBe(4);
  });

  it('refuses to move a folder into its own subfolder', () => {
    let adf = ok(makeDirectory(hd(), HD_ROOT, 'A'));
    const a = entry(rootEntries(adf), 'A').block;
    adf = ok(makeDirectory(adf, a, 'B'));
    const b = entry(entry(rootEntries(adf), 'A').children, 'B').block;
    expect(moveEntry(adf, HD_ROOT, a, b)).toEqual({ ok: false, reason: 'cycle' });
  });

  it("applies a batch whose '' parent is the HD root", () => {
    const adf = ok(applyBatch([
      { op: 'mkdir', parentPath: '', name: 'C' },
      { op: 'add', parentPath: 'C', name: 'x.txt', bytes: text('x') },
    ])(hd()));
    expect(entry(entry(rootEntries(adf), 'C').children, 'x.txt').kind).toBe('file');
  });

  it('allocates above the root and never past block 3519, the root or the bitmap (Review Focus 3)', () => {
    const adf = hd().slice();
    const got = allocate(adf, 3516)!;
    expect(got).toHaveLength(3516);
    expect(new Set(got).size).toBe(3516);
    expect(Math.max(...got)).toBe(3519);
    expect(got).not.toContain(1760);
    expect(got).not.toContain(1761);
    // The bitmap block's padding bits past 3519 are set ("free"); they must
    // never be handed out as blocks.
    expect(allocate(adf, 1)).toBeNull();
    expect(readUsage(adf)!.freeBlocks).toBe(0);
  });

  it('refuses a file that does not fit, allocating nothing', () => {
    const adf = hd();
    const r = addFile(adf, HD_ROOT, 'BIG', new Uint8Array(3516 * 512));
    expect(r).toEqual({ ok: false, reason: 'disk-full' });
    expect(readUsage(adf)!.usedBlocks).toBe(4);
  });

  it('renames the volume in the HD root block', () => {
    const v = readVolume(setVolumeName(hd(), 'Renamed'));
    if (!v.ok) throw new Error(`expected ok, got ${v.reason}`);
    expect(v.volume.name).toBe('Renamed');
  });

  it('treats a DD root number as the ordinary block it is on HD (Review Focus 2)', () => {
    const adf = ok(addFile(hd(), HD_ROOT, 'A', text('a')));
    const a = entry(rootEntries(adf), 'A').block;
    expect(moveEntry(adf, HD_ROOT, a, 880)).toEqual({ ok: false, reason: 'not-found' });
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm exec vitest run src/lib/adffs/hd.test.ts`
Expected: FAIL — `geometryOf` is not exported from `./index` (TypeError: geometryOf is not a function), and `formatVolume` ignores `density`.

- [ ] **Step 4: Add the geometry module**

Create `src/lib/adffs/geometry.ts`:

```ts
// The two AmigaDOS floppy geometries (HD writes spec §6.1). An ADF's length
// is the only thing that says which one it is: nothing inside the image is
// trusted for that, the same rule readVolume has always applied to "is this
// an ADF at all". Everything else about the filesystem is identical between
// them -- block size, hash table, header and data blocks, and ONE bitmap
// block (it holds 4,064 bits; an HD disk needs 3,518).
import { BLOCK_BYTES } from './constants';

export type Geometry = Readonly<{
  /** Blocks on the disk: 1,760 DD, 3,520 HD. */
  blockCount: number;
  /** The root block, at the middle of the disk: 880 DD, 1,760 HD. Measured
   *  on both from xdftool's own format (2026-09-27), not assumed. */
  rootBlock: number;
}>;

export const DD_GEOMETRY: Geometry = Object.freeze({ blockCount: 1760, rootBlock: 880 });
export const HD_GEOMETRY: Geometry = Object.freeze({ blockCount: 3520, rootBlock: 1760 });

/** The two boot blocks are outside the bitmap, which starts at block 2. */
export const BITMAP_FIRST_BLOCK = 2;

/** The geometry an image of this length has, or null for any other length. */
export function geometryOf(adf: Uint8Array): Geometry | null {
  if (adf.length === DD_GEOMETRY.blockCount * BLOCK_BYTES) return DD_GEOMETRY;
  if (adf.length === HD_GEOMETRY.blockCount * BLOCK_BYTES) return HD_GEOMETRY;
  return null;
}

export function geometryFor(density: 'dd' | 'hd'): Geometry {
  return density === 'hd' ? HD_GEOMETRY : DD_GEOMETRY;
}
```

In `src/lib/adffs/constants.ts` replace lines 6-9 with:

```ts
/** A DD disk's block count. An image's own geometry comes from geometryOf
 *  (geometry.ts); this stays for the DD fixtures and tests that name it. */
export const BLOCK_COUNT = 1760;
/** A DD disk's root block (spec section 3.1). An HD disk's is 1,760: ask
 *  geometryOf, never this, when reading an image. */
export const ROOT_BLOCK = 880;
```

- [ ] **Step 5: blocks.ts, root.ts and index.ts take the geometry**

In `src/lib/adffs/blocks.ts` change the import on line 7 to

```ts
import { BLOCK_BYTES, BLOCK_COUNT } from './constants';
import { geometryOf } from './geometry';
```

and replace the first line of `blockAt`'s body (line 19) with:

```ts
  // The disk's own block count (HD writes spec §6.1): 3,520 on an HD disk.
  // An image of any other length keeps the DD bound it always had, and the
  // length check below still applies to it.
  const count = geometryOf(adf)?.blockCount ?? BLOCK_COUNT;
  if (!Number.isInteger(block) || block < 0 || block >= count) return null;
```

In `src/lib/adffs/root.ts` replace line 3 with

```ts
import { CHECKSUM_WORD, T_HEADER, ST_ROOT } from './constants';
import { geometryOf, DD_GEOMETRY } from './geometry';
```

change the doc line `* Null when block 880 is not a valid root block.` to `* Null when the root block (880 DD, 1,760 HD) is not a valid root block.`, and replace line 28 with:

```ts
  const root = blockAt(adf, (geometryOf(adf) ?? DD_GEOMETRY).rootBlock);
```

Replace `src/lib/adffs/index.ts` with:

```ts
// The AmigaDOS filesystem module's public surface.
//
// Shaped like src/lib/adfmfm/: pure functions over a Uint8Array, no I/O and
// no database, so the entire format is testable in vitest. Write operations
// (write.ts, re-exported below) never mutate their input -- they return a
// new Uint8Array -- and never throw, returning a WriteResult instead.

import { geometryOf } from './geometry';
import { readBoot } from './boot';
import { readRoot, type VolumeInfo } from './root';
import { walkDirectory, type AdfEntry } from './dir';
import { readFileBytes, type FileBytes } from './file';

export { MAX_ENTRIES } from './constants';
export type { VolumeInfo } from './root';
export type { AdfEntry } from './dir';
export type { FileBytes } from './file';
export type { Filesystem, BootInfo } from './boot';
export { readUsage, type VolumeUsage } from './usage';
export {
  addFile, deleteEntry, renameEntry, replaceFile, makeDirectory, moveEntry,
  applyBatch, type WriteResult, type WriteError, type BatchOp,
} from './write';
export { blocksForFile, blocksForPlan, type CostItem } from './capacity';
export { geometryOf, geometryFor, DD_GEOMETRY, HD_GEOMETRY, type Geometry } from './geometry';

export type VolumeResult =
  | {
      ok: true; volume: VolumeInfo; root: AdfEntry[]; truncated: boolean; warnings: string[];
      /** The directory block `root` lists: 880 DD, 1,760 HD. Every caller that
       *  names "the root" by block number takes it from here (HD writes spec §6.1). */
      rootBlock: number;
    }
  | { ok: false; reason: 'not-adf' | 'no-dos-signature' | 'no-filesystem' };

/**
 * A DISCRIMINATED UNION, not a throw, because "this disk has no filesystem"
 * is an ordinary answer for 20% of a real archive (design decision D-3-3).
 * Every game and demo disk answers this way; a game disk is not a failure.
 *
 * The three failure reasons are distinguished because the page renders them
 * differently: an image that is neither 880 KB nor 1.76 MB is a catalog
 * problem, a missing signature and a missing filesystem are both ordinary
 * properties of a disk.
 */
export function readVolume(adf: Uint8Array): VolumeResult {
  const geometry = geometryOf(adf);
  if (!geometry) return { ok: false, reason: 'not-adf' };

  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-dos-signature' };

  const volume = readRoot(adf, boot);
  if (!volume) return { ok: false, reason: 'no-filesystem' };

  const { root, truncated, warnings } = walkDirectory(adf, geometry.rootBlock);
  return { ok: true, volume, root, truncated, warnings, rootBlock: geometry.rootBlock };
}

/** One file's bytes, addressed by its header block (design decision D-3-5). */
export function readFile(adf: Uint8Array, block: number): FileBytes | null {
  const boot = readBoot(adf);
  if (!boot) return null;
  return readFileBytes(adf, block, boot.filesystem);
}
```

- [ ] **Step 6: usage.ts and alloc.ts take the geometry**

In `src/lib/adffs/usage.ts` replace the import on line 14 and the local `BITMAP_FIRST_BLOCK` (lines 16-17) with:

```ts
import { BLOCK_BYTES } from './constants';
import { geometryOf, BITMAP_FIRST_BLOCK } from './geometry';
```

and replace the body of `readUsage` (lines 43-85, keeping the comments that sit between the statements) with:

```ts
  // The disk's own geometry (HD writes spec §6.1). Any other length has no
  // bitmap this code knows where to find.
  const g = geometryOf(adf);
  if (!g) return null;

  const root = g.rootBlock * BLOCK_BYTES;
  // bm_flag is -1 when the bitmap is VALID. Anything else means AmigaDOS
  // itself considers it stale and would rebuild it on mount, so reporting
  // numbers from it would be reporting numbers the Amiga is about to discard.
  if ((be32(adf, root + 312) | 0) !== -1) return null;

  // bm_pages[0], read rather than assumed: 881 DD, 1761 HD on every disk
  // measured, but the root block is where the format says to look.
  const page = be32(adf, root + 316);
  if (page < BITMAP_FIRST_BLOCK || page >= g.blockCount || page === g.rootBlock) return null;

  const bm = page * BLOCK_BYTES;
  let freeBlocks = 0;
  // A SET bit means FREE -- the same inversion the writer documents, and the
  // one thing here most likely to be read backwards. One bitmap block covers
  // either density: 3,518 bits for HD against its 4,064.
  for (let bit = 0; bit < g.blockCount - BITMAP_FIRST_BLOCK; bit++) {
    const o = bm + 4 + (bit >>> 5) * 4;
    if ((be32(adf, o) & (1 << (bit & 31))) !== 0) freeBlocks++;
  }

  // The bitmap must at least claim its own block. A bitmap of all-ones says
  // "every block free" including itself, which is not a real disk -- it is an
  // uninitialised or misread block, and it would tell someone an almost-full
  // disk was empty.
  const selfBit = page - BITMAP_FIRST_BLOCK;
  const selfWord = be32(adf, bm + 4 + (selfBit >>> 5) * 4);
  if ((selfWord & (1 << (selfBit & 31))) !== 0) return null;

  // Used counts the two boot blocks, which are outside the bitmap but are
  // certainly not free space. This is also what xdftool reports, so the two
  // agree disk for disk.
  const usedBlocks = g.blockCount - freeBlocks;
  return {
    totalBlocks: g.blockCount,
    usedBlocks,
    freeBlocks,
    totalBytes: g.blockCount * BLOCK_BYTES,
    usedBytes: usedBlocks * BLOCK_BYTES,
    freeBytes: freeBlocks * BLOCK_BYTES,
    percentUsed: Math.round((usedBlocks / g.blockCount) * 100),
  };
```

In `src/lib/adffs/alloc.ts`:
- In the header comment, change `The bitmap covers blocks 2..1759 (BITMAP_FIRST_BLOCK..BLOCK_COUNT-1).` to `The bitmap covers blocks 2..blockCount-1 (1759 DD, 3519 HD).` and `Block 880 (root)` to `The root block (880 DD, 1760 HD)`.
- Replace lines 18 and 23 (the constants import and the local `BITMAP_FIRST_BLOCK`) with:

```ts
import { BLOCK_BYTES } from './constants';
import { geometryOf, BITMAP_FIRST_BLOCK, type Geometry } from './geometry';
```

- Directly after the imports add:

```ts
/**
 * The geometry of an image `bitmapPage()` has already accepted. readUsage
 * (its trust test) returns null for any length geometryOf does not know, so
 * past a non-null page this is never null.
 */
function trustedGeometry(adf: Uint8Array): Geometry {
  return geometryOf(adf)!;
}
```

- In `bitmapPage`, replace `return be32(adf, ROOT_BLOCK * BLOCK_BYTES + 316);` with `return be32(adf, trustedGeometry(adf).rootBlock * BLOCK_BYTES + 316);`.
- In `isFree`, replace the guard line with:

```ts
  const g = trustedGeometry(adf);
  if (block === g.rootBlock || block === page || block < BITMAP_FIRST_BLOCK || block >= g.blockCount) return false;
```

- In `allocate`, replace the loop header and its first statement with:

```ts
  const g = trustedGeometry(adf);
  for (let b = BITMAP_FIRST_BLOCK; b < g.blockCount && out.length < n; b++) {
    if (b === g.rootBlock || b === page) continue;
```

- In `free`, replace the line `for (const b of blocks) {` and the guard line under it with:

```ts
  const g = trustedGeometry(adf);
  for (const b of blocks) {
    if (b === g.rootBlock || b === page || b < BITMAP_FIRST_BLOCK || b >= g.blockCount) continue;
```

(the existing `setBit(adf, page, b, true);` line and the closing brace stay).

- [ ] **Step 7: format.ts formats either density**

In `src/lib/adffs/format.ts` replace lines 15-31 (imports, `BITMAP_BLOCK`, `BITMAP_FIRST_BLOCK`, `BITMAP_BITS`) with:

```ts
import {
  BLOCK_BYTES, ROOT_BLOCK, HASH_TABLE_SIZE,
  CHECKSUM_WORD, T_HEADER, ST_ROOT,
} from './constants';
import { blockChecksum } from './blocks';
import { geometryOf, geometryFor, BITMAP_FIRST_BLOCK, DD_GEOMETRY } from './geometry';
import type { Filesystem } from './boot';

/** A DD disk's bitmap block: immediately after the root, where a real format
 *  puts it. An HD disk's is 1,761 -- the same rule, `rootBlock + 1`. */
export const BITMAP_BLOCK = ROOT_BLOCK + 1;
```

Add to `FormatOptions` (after `now?: Date;`):

```ts
  /** 'dd' (880 KB, 1,760 blocks) unless asked for 'hd' (1.76 MB, 3,520
   *  blocks, root 1,760) -- HD writes spec §6.3. */
  density?: 'dd' | 'hd';
```

Replace `formatVolume` (lines 95-165) with:

```ts
/**
 * A freshly formatted, empty volume: 880 KB, or 1.76 MB for `density: 'hd'`.
 *
 * Byte-identical to `xdftool create + format` except for the two timestamps
 * -- proven in format.test.ts for DD, and by `pnpm adffs:verify` for both.
 */
export function formatVolume(opts: FormatOptions): Uint8Array {
  const g = geometryFor(opts.density ?? 'dd');
  const bitmapBlock = g.rootBlock + 1;
  const adf = new Uint8Array(BLOCK_BYTES * g.blockCount);
  const when = opts.now ?? new Date();

  // --- boot block -------------------------------------------------------
  adf[0] = 0x44; adf[1] = 0x4f; adf[2] = 0x53;            // 'DOS'
  adf[3] = (opts.filesystem === 'FFS' ? FLAG_FFS : 0)
    | (opts.intl ? FLAG_INTL : 0);
  // Bytes 4..7 are the boot checksum and are left ZERO, which is what
  // xdftool writes for a formatted-but-not-bootable disk. readBoot does not
  // verify it (D-3-2: only 19 of 49 sound archive disks have a valid one),
  // and claiming a checksum for boot code that does not exist would be worse
  // than leaving it absent.
  putBe32(adf, 8, g.rootBlock);

  // --- root block -------------------------------------------------------
  const root = g.rootBlock * BLOCK_BYTES;
  putBe32(adf, root + 0, T_HEADER);
  // header_key and high_seq are 0 on a root block; hash table size is not.
  putBe32(adf, root + 12, HASH_TABLE_SIZE);
  // The hash table (72 longs from offset 24) stays zero: no entries yet.
  putBe32(adf, root + 312, 0xffffffff);                    // bm_flag: valid
  putBe32(adf, root + 316, bitmapBlock);                   // bm_pages[0]
  // THREE date triples, not one. Omitting any leaves it zero, which reads as
  // 1978-01-01 on an Amiga and differs from a real format.
  putAmigaDate(adf, root + 420, when);   // last change to the root DIRECTORY
  putBcpl(adf, root + 432, opts.volumeName, MAX_VOLUME_NAME);
  putAmigaDate(adf, root + 472, when);   // last change to the VOLUME
  putAmigaDate(adf, root + 484, when);   // volume created
  putBe32(adf, root + 508, ST_ROOT);
  putBe32(adf, root + CHECKSUM_WORD * 4,
    blockChecksum(adf.subarray(root, root + BLOCK_BYTES), CHECKSUM_WORD));

  // --- bitmap block -----------------------------------------------------
  //
  // A SET BIT MEANS FREE. This is the single most invertible fact in the
  // format and the one the reader cannot catch: a bitmap that is exactly
  // wrong still reads perfectly, and only corrupts when a real Amiga writes
  // to the disk and believes an occupied block is available.
  const bm = bitmapBlock * BLOCK_BYTES;
  // Every bit free to begin with, INCLUDING the trailing bits past the last
  // block -- xdftool leaves the whole remainder of the block 0xff on both
  // densities, and matching it keeps the two outputs diffable. alloc.ts
  // never hands those padding bits out (it bounds by the geometry).
  adf.fill(0xff, bm + 4, bm + BLOCK_BYTES);
  for (const used of [g.rootBlock, bitmapBlock]) {
    const bit = used - BITMAP_FIRST_BLOCK;
    const wordOffset = bm + 4 + (bit >>> 5) * 4;
    const mask = 1 << (bit & 31);
    // Read-modify-write big-endian, clearing the bit: allocated.
    const word = ((adf[wordOffset] << 24) | (adf[wordOffset + 1] << 16)
      | (adf[wordOffset + 2] << 8) | adf[wordOffset + 3]) >>> 0;
    putBe32(adf, wordOffset, (word & ~mask) >>> 0);
  }
  // The bitmap's checksum makes the sum of ALL 128 longs in the block zero,
  // and unlike every other block here the checksum sits at offset 0 rather
  // than word 5.
  putBe32(adf, bm, 0);
  let sum = 0;
  for (let o = bm; o < bm + BLOCK_BYTES; o += 4) {
    sum = (sum + (((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0)) >>> 0;
  }
  putBe32(adf, bm, (-sum >>> 0));

  return adf;
}

/** Blocks the bitmap says are in use. Exported for tests and future writes. */
export function usedBlocks(adf: Uint8Array): number[] {
  const g = geometryOf(adf);
  if (!g) return [];
  const bm = (g.rootBlock + 1) * BLOCK_BYTES;
  const used: number[] = [];
  for (let bit = 0; bit < g.blockCount - BITMAP_FIRST_BLOCK; bit++) {
    const o = bm + 4 + (bit >>> 5) * 4;
    const word = ((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0;
    if ((word & (1 << (bit & 31))) === 0) used.push(bit + BITMAP_FIRST_BLOCK);
  }
  return used;
}
```

In `setVolumeName`, replace `const root = ROOT_BLOCK * BLOCK_BYTES;` with:

```ts
  const root = (geometryOf(adf) ?? DD_GEOMETRY).rootBlock * BLOCK_BYTES;
```

- [ ] **Step 8: file.ts and write.ts take the geometry**

In `src/lib/adffs/file.ts` add `import { geometryOf } from './geometry';` after the `./blocks` import. In `collectFileBlocks`, directly before `while (current !== null) {` add:

```ts
  // The disk's own block count caps the pointer list (see the comment below):
  // 1,760 DD, 3,520 HD. An image of another length keeps the DD cap.
  const maxData = geometryOf(adf)?.blockCount ?? BLOCK_COUNT;
```

and in the loop replace `if (data.length >= BLOCK_COUNT) { capped = true; break; }` with `if (data.length >= maxData) { capped = true; break; }` and the warning with ``warn(`data pointer list exceeds ${maxData} blocks; stopping collection`);``. In the comment above, change `so the pointer list is capped at BLOCK_COUNT (1,760) and` to `so the pointer list is capped at the disk's block count and`.

In `src/lib/adffs/write.ts`:
- Remove `ROOT_BLOCK,` from the `./constants` import (lines 8-12).
- After the last import add:

```ts
import { geometryOf, DD_GEOMETRY } from './geometry';

/** This disk's root block: 880 DD, 1,760 HD (HD writes spec §6.1). */
function rootOf(adf: Uint8Array): number {
  return (geometryOf(adf) ?? DD_GEOMETRY).rootBlock;
}
```

- In `ancestryOf`, add `const root = rootOf(adf);` as its first statement and change `if (cur === ROOT_BLOCK) break;` to `if (cur === root) break;`. In its comment change `an 880K image has exactly BLOCK_COUNT (1,760)` to `an image has exactly its geometry's block count (1,760 or 3,520)` and `before reaching \`ROOT_BLOCK\`` to `before reaching the root`.
- In `moveEntry`, change `if (toParent !== ROOT_BLOCK && destKind !== ST_USERDIR) {` to `if (toParent !== rootOf(adf) && destKind !== ST_USERDIR) {`.
- In `applyBatch`, change `const dirs = new Map<string, number>([['', ROOT_BLOCK]]);` to `const dirs = new Map<string, number>([['', rootOf(adf)]]);`.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
pnpm exec vitest run src/lib/adffs
pnpm exec tsc --noEmit -p .
pnpm lint
```

Expected: every adffs test passes (the DD suite unchanged, `hd.test.ts` green); no type or lint errors. `grep -n "ROOT_BLOCK\|BLOCK_COUNT" src/lib/adffs/*.ts | grep -v test` shows only `constants.ts`, `blocks.ts` (the fallback), `file.ts` (the fallback), `format.ts` (`BITMAP_BLOCK`) and `synthetic.ts` (a DD fixture builder).

- [ ] **Step 10: Commit**

```bash
git add src/lib/adffs/geometry.ts src/lib/adffs/hd.test.ts src/lib/adffs/constants.ts src/lib/adffs/blocks.ts \
  src/lib/adffs/root.ts src/lib/adffs/index.ts src/lib/adffs/usage.ts src/lib/adffs/alloc.ts \
  src/lib/adffs/format.ts src/lib/adffs/file.ts src/lib/adffs/write.ts
git commit -F- <<'EOF'
adffs: HD geometry (3,520 blocks, root 1,760) from the image length

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 2: xdftool cross-checks HD disks in both directions

**Files:**
- Modify: `scripts/adffs-verify.ts:22-31` (imports), `:203-230` (`proves`), and append an HD section before the final `rmSync` (line ~454)

**Interfaces:**
- Consumes: Task 1's `formatVolume({ density: 'hd' })`, `readVolume(...).rootBlock`, `readFile`, `readUsage`.
- Produces: `pnpm adffs:verify` covers HD (not part of `pnpm test`; xdftool is not in CI).

- [ ] **Step 1: Confirm xdftool is present and the DD checks pass before touching the script**

```bash
which xdftool && pnpm adffs:verify 2>&1 | tail -2
```

Expected: `/opt/homebrew/bin/xdftool` and `All checks passed.`

- [ ] **Step 2: Name HD images `.hdf` in `proves`**

In `scripts/adffs-verify.ts` change the import on the `../src/lib/adffs` line to

```ts
import { readVolume, readFile, readUsage } from '../src/lib/adffs';
```

and replace the first line of `proves`' body (`const image = join(dir, \`${label.replace(/\W/g, '')}.adf\`);`) with:

```ts
  // An HD image goes to xdftool as `.hdf`: amitools 0.4.0's ADF device is
  // DD-only (see the HD section at the end of this file).
  const ext = adf.length === 1_802_240 ? 'hdf' : 'adf';
  const image = join(dir, `${label.replace(/\W/g, '')}.${ext}`);
```

- [ ] **Step 3: Append the HD section**

Insert directly before the line `rmSync(dir, { recursive: true, force: true });`:

```ts
// ---------------------------------------------------------------------------
// HD (HD writes spec §6.4): the same second opinion at 3,520 blocks, in both
// directions.
//
// amitools 0.4.0's ADF device is DD-only -- `format` on a 1.8 MB `.adf`
// silently rewrites it as 901,120 bytes. Its HDF device takes the geometry
// from the file size, so an HD image goes to xdftool under an `.hdf` name.
// Measured 2026-09-27: `xdftool x.hdf create chs=80,2,22 + format N ffs`
// writes root 1760, bitmap 1761 and boot pointer 1760 -- the layout
// formatVolume({ density: 'hd' }) writes -- and `info` says 3520 total, 4 used.
const HD_ROOT = 1760;

console.log('\nHD: our blank disks');
for (const filesystem of ['OFS', 'FFS'] as const) {
  const name = `OursHD${filesystem}`;
  const image = join(dir, `ours-hd-${filesystem}.hdf`);
  writeFileSync(image, formatVolume({ filesystem, volumeName: name, density: 'hd' }));

  const info = xdftool(image, 'info');
  check(`HD ${filesystem}: xdftool reports 3520 blocks`, /total:\s+3520\b/.test(info), info.split('\n')[0]?.trim());
  check(`HD ${filesystem}: xdftool reports 4 blocks used`, /used:\s+4\b/.test(info), info.split('\n')[1]?.trim());
  check(`HD ${filesystem}: xdftool reports 3516 free`, /free:\s+3516\b/.test(info), info.split('\n')[2]?.trim());

  const list = xdftool(image, 'list');
  check(`HD ${filesystem}: volume name and filesystem recognised`,
    list.includes(name) && list.includes(filesystem === 'FFS' ? 'ffs' : 'ofs'),
    list.split('\n')[0]?.trim());

  // THE ONE THAT MATTERS, as for DD: they allocate out of OUR bitmap.
  xdftool(image, 'write', payload, 'hello.txt');
  check(`HD ${filesystem}: xdftool can write a file into our disk`, xdftool(image, 'list').includes('hello.txt'));

  const reread = readVolume(new Uint8Array(readFileSync(image)));
  check(`HD ${filesystem}: our reader still reads it after their write`,
    reread.ok && reread.rootBlock === HD_ROOT && reread.root.some((e) => e.name === 'hello.txt'),
    reread.ok ? `root=${reread.rootBlock} entries=[${reread.root.map((e) => e.name).join(', ')}]` : `reason=${reread.reason}`);
}

console.log('\nHD: our write operations, proved by xdftool');
for (const filesystem of ['OFS', 'FFS'] as const) {
  const blank = () => formatVolume({ filesystem, volumeName: `Hd${filesystem}`, density: 'hd' });

  {
    const added = addFile(blank(), HD_ROOT, 'add.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: HD add failed (${added.reason})`);
    proves(`HD ${filesystem} add`, added.adf, ['add.txt']);
  }

  {
    const added = addFile(blank(), HD_ROOT, 'big.bin', largePayload);
    if (!added.ok) throw new Error(`setup: HD add-large failed (${added.reason})`);
    proves(`HD ${filesystem} add-large`, added.adf, ['big.bin']);
  }

  {
    const added = addFile(blank(), HD_ROOT, 'old.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: HD rename setup failed (${added.reason})`);
    const renamed = renameEntry(added.adf, HD_ROOT, blockOf(added.adf, 'old.txt'), 'new.txt');
    if (!renamed.ok) throw new Error(`setup: HD rename failed (${renamed.reason})`);
    proves(`HD ${filesystem} rename`, renamed.adf, ['new.txt']);
  }

  {
    const made = makeDirectory(blank(), HD_ROOT, 'sub');
    if (!made.ok) throw new Error(`setup: HD mkdir failed (${made.reason})`);
    const added = addFile(made.adf, blockOf(made.adf, 'sub'), 'inner.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: HD add-into-dir failed (${added.reason})`);
    proves(`HD ${filesystem} add-into-dir`, added.adf, ['sub', 'inner.txt']);
  }

  {
    const made = makeDirectory(blank(), HD_ROOT, 'doomed');
    if (!made.ok) throw new Error(`setup: HD delete-dir mkdir failed (${made.reason})`);
    const dirBlock = blockOf(made.adf, 'doomed');
    const added = addFile(made.adf, dirBlock, 'inside.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: HD delete-dir add failed (${added.reason})`);
    const deleted = deleteEntry(added.adf, HD_ROOT, dirBlock);
    if (!deleted.ok) throw new Error(`setup: HD delete-dir failed (${deleted.reason})`);
    const image = proves(`HD ${filesystem} delete-dir`, deleted.adf, []);
    const listing = xdftool(image, 'list');
    check(`HD ${filesystem} delete-dir: doomed is really gone`, !listing.toUpperCase().includes('DOOMED'));
  }

  {
    const seeded = addFile(blank(), HD_ROOT, 'root.txt', smallPayload);
    if (!seeded.ok) throw new Error(`setup: HD batch seed failed (${seeded.reason})`);
    const batched = applyBatch([
      { op: 'mkdir', parentPath: '', name: 'C' },
      { op: 'add', parentPath: 'C', name: 'one.txt', bytes: smallPayload },
    ])(seeded.adf);
    if (!batched.ok) throw new Error(`setup: HD batch failed (${batched.reason})`);
    const moved = moveEntry(batched.adf, HD_ROOT, blockOf(batched.adf, 'root.txt'), blockOf(batched.adf, 'C'));
    if (!moved.ok) throw new Error(`setup: HD move failed (${moved.reason})`);
    const image = proves(`HD ${filesystem} batch and move`, moved.adf, ['C', 'one.txt', 'root.txt']);
    check(`HD ${filesystem} move: xdftool sees root.txt inside C`,
      xdftool(image, 'list', 'C').toUpperCase().includes('ROOT.TXT'));
    checkParentConsistency(`HD ${filesystem} move`, image);
  }

  {
    // Past the middle: 2,000 blocks cannot all come from below the root, so
    // this file's data lands above block 1,760 -- where no DD disk has blocks
    // at all. xdftool EXTRACTS it and it must be the same bytes.
    const big = new Uint8Array(2000 * 512);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const added = addFile(blank(), HD_ROOT, 'past-root.bin', big);
    if (!added.ok) throw new Error(`setup: HD past-root add failed (${added.reason})`);
    const image = proves(`HD ${filesystem} past-root`, added.adf, ['past-root.bin']);
    const out = join(dir, `past-root-${filesystem}.bin`);
    xdftool(image, 'read', 'past-root.bin', out);
    check(`HD ${filesystem} past-root: xdftool extracts our bytes exactly`,
      Buffer.compare(readFileSync(out), Buffer.from(big)) === 0);
  }
}

console.log("\nHD: xdftool's disk, our reader and writer");
{
  const image = join(dir, 'theirs-hd.hdf');
  const inner = join(dir, 'inner.txt');
  writeFileSync(inner, 'made by xdftool\n');
  xdftool(image, 'create', 'chs=80,2,22', '+', 'format', 'TheirsHD', 'ffs',
    '+', 'makedir', 'Dir', '+', 'write', inner, 'Dir/inner.txt', '+', 'write', payload, 'top.txt');
  const theirs = new Uint8Array(readFileSync(image));
  check('their HD disk is 1,802,240 bytes', theirs.length === 1_802_240, `${theirs.length}`);

  const v = readVolume(theirs);
  check('our reader opens their HD disk at root 1760',
    v.ok && v.rootBlock === HD_ROOT && v.volume.name === 'TheirsHD',
    v.ok ? `root=${v.rootBlock} name=${v.volume.name}` : `reason=${v.reason}`);
  if (v.ok) {
    const innerEntry = v.root.find((e) => e.name === 'Dir')?.children.find((e) => e.name === 'inner.txt');
    const got = innerEntry ? readFile(theirs, innerEntry.block) : null;
    check('we read their nested file byte for byte',
      got !== null && Buffer.from(got.bytes).toString() === 'made by xdftool\n');
  }

  const usage = readUsage(theirs);
  check('our used-block count agrees with xdftool info',
    usage !== null && new RegExp(`used:\\s+${usage.usedBlocks}\\b`).test(xdftool(image, 'info')),
    usage ? `ours: ${usage.usedBlocks} used` : 'bitmap untrusted');

  const added = addFile(theirs, HD_ROOT, 'ours.txt', smallPayload);
  check('we can add a file to their HD disk', added.ok, added.ok ? '' : added.reason);
  if (added.ok) proves('HD ours-into-theirs', added.adf, ['Dir', 'top.txt', 'ours.txt']);
}
```

- [ ] **Step 4: Run it**

Run: `pnpm adffs:verify 2>&1 | tail -40`
Expected: every line `ok`, ending `All checks passed.` If `HD … xdftool reports 4 blocks used` fails, the HD format differs from xdftool's; fix `formatVolume` (Task 1), never the check.

- [ ] **Step 5: Mutation check (proves the HD checks can fail)**

Temporarily change `const bitmapBlock = g.rootBlock + 1;` in `formatVolume` to `const bitmapBlock = g.rootBlock + 2;`, run `pnpm adffs:verify 2>&1 | grep -c FAIL` (expected: a non-zero count, including HD lines), then restore the line and run `pnpm adffs:verify 2>&1 | tail -1` (expected `All checks passed.`). Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git add scripts/adffs-verify.ts
git commit -F- <<'EOF'
adffs:verify: xdftool cross-checks HD disks both ways (as .hdf; amitools' ADF device is DD-only)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 3: History takes its size from the image

**Files:**
- Modify: `src/lib/disk-history/delta.ts` (lines 1, 24-47, 50-85, 141, 167-171), `src/lib/disk-history/chain.ts` (lines 1-2, 55-62, 107-110), `src/lib/disk-history/version.ts` (whole file), `src/lib/disk-history/history.ts` (lines 2, 8, 196-199), `src/lib/disk-history/restore.ts` (after line 113)
- Test: `src/lib/disk-history/delta.test.ts`, `chain.test.ts`, `version.test.ts`, `history.test.ts`, `restore.test.ts`

**Interfaces:**
- Consumes: Task 1's `formatVolume({ density: 'hd' })`, `addFile`.
- Produces:
  - `delta.ts`: `MAX_SECTORS_PER_DISK = 3520`, `isHistoryImage(img: Uint8Array): boolean`, `shouldSnapshot(changedSectors: number, imageBytes?: number)` (default `ADF_BYTES`). `SECTORS_PER_DISK` stays (1,760, DD).
  - `chain.ts`: `nextKind(changedSectors: number, deltasSinceSnapshot: number, imageBytes?: number)`.
  - `version.ts`: `trackBytesForImage(imageBytes: number): number | null`, `trackBytesForDisk(d: { imageFormat: string; sizeBytes: number }): number | null`, `isTrackUpload(track: number, data: Uint8Array, trackBytes?: number)` (default 5,632), `overlayTracks(head, tracks)` (track size from `head.length`).
  - `restoreVersion` answers `{ ok: false, status: 409, reason: 'size_mismatch' }` when the target and head differ in size.

- [ ] **Step 1: Write the failing tests**

In `src/lib/disk-history/delta.test.ts`:
- Change the imports to

```ts
import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm';
import {
  buildDelta, applyDelta, encodeDelta, decodeDelta, encodedSize,
  shouldSnapshot, DeltaError, SECTOR_BYTES, SECTORS_PER_DISK, MAX_SECTORS_PER_DISK,
} from './delta';
```

- Replace the test `rejects a sector index outside the disk` with:

```ts
  it('rejects a sector index past the largest disk, and applies none past the image it is given', () => {
    // A WDLD blob does not say which disk it belongs to (the format is
    // unchanged, HD writes spec §5.2), so decode bounds by the largest disk
    // and apply bounds by the image.
    const d = buildDelta(noise(9), withSector(noise(9), 5, 0x99));
    const enc = encodeDelta(d);
    new DataView(enc.buffer).setUint32(16, MAX_SECTORS_PER_DISK);   // one past an HD disk
    expect(() => decodeDelta(enc)).toThrow(/outside the disk/);

    new DataView(enc.buffer).setUint32(16, SECTORS_PER_DISK);       // one past a DD disk
    const decoded = decodeDelta(enc);
    expect(() => applyDelta(noise(9), decoded)).toThrow(/outside the disk/);
    expect(applyDelta(noise(9, ADF_HD_BYTES), decoded).length).toBe(ADF_HD_BYTES);
  });
```

- Add, inside `describe('buildDelta / applyDelta', …)`:

```ts
  it('round-trips an HD image, including a sector past the DD end', () => {
    const before = noise(21, ADF_HD_BYTES);
    const after = withSector(withSector(before, 3, 0xaa), 3519, 0xbb);
    const d = buildDelta(before, after);
    expect(d.sectors).toEqual([3, 3519]);
    expect(firstDiff(applyDelta(before, decodeDelta(encodeDelta(d))), after)).toBe(SAME);
  });

  it('refuses two images of different sizes: a disk has one size', () => {
    expect(() => buildDelta(noise(22), noise(22, ADF_HD_BYTES))).toThrow(DeltaError);
    expect(() => buildDelta(noise(23, ADF_HD_BYTES), noise(23))).toThrow(/one size/);
  });
```

- Add, inside `describe('shouldSnapshot', …)`:

```ts
  it("judges half the disk against the image's own size (Review Focus 4)", () => {
    // 1,000 sectors is past half a DD disk but under half an HD one.
    expect(shouldSnapshot(1000)).toBe(true);
    expect(shouldSnapshot(1000, ADF_HD_BYTES)).toBe(false);
    expect(shouldSnapshot(MAX_SECTORS_PER_DISK, ADF_HD_BYTES)).toBe(true);
  });
```

In `src/lib/disk-history/chain.test.ts` change the imports to

```ts
import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm';
import {
  replayPlan, materialise, nextKind, deltasSinceSnapshot,
  MAX_CHAIN_DEPTH, type VersionEntry,
} from './chain';
import { buildDelta, encodeDelta, SECTOR_BYTES, SECTORS_PER_DISK, MAX_SECTORS_PER_DISK } from './delta';
```

and add inside `describe('nextKind', …)`:

```ts
  it("takes the snapshot threshold from the disk's own size (HD writes spec §5.2)", () => {
    expect(nextKind(1000, 0)).toBe('snapshot');
    expect(nextKind(1000, 0, ADF_HD_BYTES)).toBe('delta');
    expect(nextKind(MAX_SECTORS_PER_DISK, 0, ADF_HD_BYTES)).toBe('snapshot');
  });
```

and a new block at the end of the file:

```ts
describe('materialise, HD', () => {
  it('replays an HD chain', async () => {
    const base = new Uint8Array(ADF_HD_BYTES).fill(1);
    const next = base.slice();
    next.fill(9, 3000 * SECTOR_BYTES, 3001 * SECTOR_BYTES);   // past a DD disk's end
    const blobs = new Map<string, Uint8Array>([
      ['s0', base], ['d1', encodeDelta(buildDelta(base, next))],
    ]);
    const entries: VersionEntry[] = [
      { seq: 0, kind: 'snapshot', blobSha256: 's0', imageSha256: 'i0' },
      { seq: 1, kind: 'delta', blobSha256: 'd1', imageSha256: 'i1' },
    ];
    const got = await materialise(entries, 1, async (sha) => blobs.get(sha)!);
    expect(got.length).toBe(ADF_HD_BYTES);
    expect(got[3000 * SECTOR_BYTES]).toBe(9);
    expect(got[2999 * SECTOR_BYTES]).toBe(1);
  });
});
```

In `src/lib/disk-history/version.test.ts` change the imports to

```ts
import { ADF_BYTES, ADF_HD_BYTES, HD_TRACK_DATA_BYTES, TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { decodeDelta, SECTOR_BYTES } from './delta';
import type { VersionEntry } from './chain';
import { MAX_CHAIN_DEPTH } from './chain';
import { overlayTracks, planNextVersion, isTrackUpload, trackBytesForDisk, trackBytesForImage } from './version';
```

and add at the end:

```ts
describe('HD tracks (HD writes spec §5.1)', () => {
  const hdImg = (fill = 0) => new Uint8Array(ADF_HD_BYTES).fill(fill);
  const hdTrack = (fill: number) => new Uint8Array(HD_TRACK_DATA_BYTES).fill(fill);

  it('sizes a track by the disk: 5,632 DD, 11,264 HD, nothing for an HFE or an odd size', () => {
    expect(trackBytesForDisk({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(TRACK_DATA_BYTES);
    expect(trackBytesForDisk({ imageFormat: 'adf', sizeBytes: 1_802_240 })).toBe(HD_TRACK_DATA_BYTES);
    expect(trackBytesForDisk({ imageFormat: 'hfe', sizeBytes: 1_802_240 })).toBeNull();
    expect(trackBytesForDisk({ imageFormat: 'adf', sizeBytes: 12 })).toBeNull();
    expect(trackBytesForImage(ADF_BYTES)).toBe(TRACK_DATA_BYTES);
    expect(trackBytesForImage(ADF_HD_BYTES)).toBe(HD_TRACK_DATA_BYTES);
    expect(trackBytesForImage(5)).toBeNull();
  });

  it("accepts exactly this disk's size, never the other density's", () => {
    expect(isTrackUpload(0, hdTrack(0), HD_TRACK_DATA_BYTES)).toBe(true);
    expect(isTrackUpload(0, track(0), HD_TRACK_DATA_BYTES)).toBe(false);
    expect(isTrackUpload(0, hdTrack(0))).toBe(false);          // the default is DD
    expect(isTrackUpload(160, hdTrack(0), HD_TRACK_DATA_BYTES)).toBe(false);
  });

  it('overlays track 159 onto the last 11,264 bytes of an HD image (Review Focus 4)', () => {
    const out = overlayTracks(hdImg(0), [{ track: 159, data: hdTrack(7) }]);
    expect(out[ADF_HD_BYTES - HD_TRACK_DATA_BYTES - 1]).toBe(0);
    expect(out[ADF_HD_BYTES - HD_TRACK_DATA_BYTES]).toBe(7);
    expect(out[ADF_HD_BYTES - 1]).toBe(7);
  });

  it('refuses a DD track on an HD head, and an HD track on a DD head', () => {
    expect(() => overlayTracks(hdImg(), [{ track: 0, data: track(1) }])).toThrow();
    expect(() => overlayTracks(img(), [{ track: 0, data: hdTrack(1) }])).toThrow();
  });

  it('plans a 1,000-sector HD save as a delta, not a snapshot (Review Focus 4)', () => {
    const next = hdImg(0);
    for (let s = 0; s < 1000; s++) next[s * SECTOR_BYTES] = 1;
    const p = planNextVersion([v0], hdImg(0), next)!;
    expect(p.kind).toBe('delta');
    expect(p.sectorCount).toBe(1000);
  });
});
```

In `src/lib/disk-history/history.test.ts` add inside `describe('loadHistory', …)`:

```ts
  it('lists file-level changes for an HD disk (HD writes spec §5.2)', async () => {
    const { recordVersion } = await import('./store');
    const { loadHistory } = await import('./history');

    const original = formatVolume({ filesystem: 'FFS', volumeName: 'HDDisk', density: 'hd' });
    blobBytes.set(sha256Of(original), original);
    const added = addFile(original, 1760, 'HELLO', new TextEncoder().encode('hi'));
    if (!added.ok) throw new Error(`fixture: ${added.reason}`);

    await recordVersion({
      orgId: ORG, diskId: DISK,
      headSha: sha256Of(original), head: original, next: added.adf,
      source: 'amiga', deviceId: 'dev-1', sourceFilename: 'HDDisk.adf',
    });

    const history = await loadHistory(ORG, DISK, new Map([['dev-1', 'Bench board']]));
    expect(history.map((v) => v.seq)).toEqual([1, 0]);
    expect(history[0].changes).toEqual([{ path: 'HELLO', kind: 'added', isDir: false }]);
    expect(history[0].sectorNote).toBeNull();
  });
```

In `src/lib/disk-history/restore.test.ts` add inside `describe('restoreVersion', …)`:

```ts
  it('refuses a target whose size differs from the head, recording nothing (Review Focus 5)', async () => {
    await buildChain(['A']);   // DD versions 0..1
    // The head the disk row points at is an HD image: only reachable by a
    // hand-edited row or blob, and it must be a refusal, never a 500.
    const hdHead = formatVolume({ filesystem: 'FFS', volumeName: 'Other', density: 'hd' });
    blobBytes.set(sha256Of(hdHead), hdHead);
    diskLookupResult = [{ sha256: sha256Of(hdHead), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    expect(await restoreVersion(ORG, DISK, 0, null)).toEqual({ ok: false, status: 409, reason: 'size_mismatch' });
    expect(diskVersionRows).toHaveLength(rowCountBefore);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/lib/disk-history`
Expected: FAIL — `MAX_SECTORS_PER_DISK`, `trackBytesForDisk` and `trackBytesForImage` are not exported; `buildDelta` rejects an HD image (`must be 901120 bytes`); the restore test gets `status 500`/a thrown `DeltaError` instead of `size_mismatch`.

- [ ] **Step 3: delta.ts**

In `src/lib/disk-history/delta.ts` replace line 1 with

```ts
import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm/constants';
```

replace lines 24-25 and `assertImage` (lines 43-47) with:

```ts
export const SECTOR_BYTES = 512;
/** A DD disk's sectors. An image's own count is its length / 512. */
export const SECTORS_PER_DISK = ADF_BYTES / SECTOR_BYTES;   // 1760
/** The most sectors any disk here has: an HD disk's (HD writes spec §5.2). */
export const MAX_SECTORS_PER_DISK = ADF_HD_BYTES / SECTOR_BYTES;   // 3520

/** The two image sizes history records: 901,120 (DD) and 1,802,240 (HD). */
export function isHistoryImage(img: Uint8Array): boolean {
  return img.length === ADF_BYTES || img.length === ADF_HD_BYTES;
}

/** The image's sector count, or a DeltaError for any other size. */
function assertImage(img: Uint8Array, what: string): number {
  if (!isHistoryImage(img)) {
    throw new DeltaError(`${what} must be ${ADF_BYTES} or ${ADF_HD_BYTES} bytes, got ${img.length}`);
  }
  return img.length / SECTOR_BYTES;
}
```

(`assertImage` must sit below the `DeltaError` class; move the constants block above `const MAGIC` and leave `assertImage` where it was.)

Replace the first three lines of `buildDelta`'s body and its loop header with:

```ts
  const sectorsInImage = assertImage(before, 'before');
  assertImage(after, 'after');
  // A disk's versions are all one size (HD writes spec §5.2): a DD image and
  // an HD one are not two states of the same disk.
  if (before.length !== after.length) {
    throw new DeltaError(`before is ${before.length} bytes and after is ${after.length}: a disk has one size`);
  }

  const sectors: number[] = [];
  for (let s = 0; s < sectorsInImage; s++) {
```

In `applyDelta` replace `assertImage(image, 'image');` with `const sectorsInImage = assertImage(image, 'image');` and `s >= SECTORS_PER_DISK` with `s >= sectorsInImage`.

In `decodeDelta` replace `if (s >= SECTORS_PER_DISK) throw …` with:

```ts
    // Bounded by the LARGEST disk: a delta does not say which disk it is for,
    // so applyDelta bounds it again by the image it is applied to.
    if (s >= MAX_SECTORS_PER_DISK) throw new DeltaError(`sector ${s} is outside the disk`);
```

Replace `shouldSnapshot` with:

```ts
/** `imageBytes` is the disk's own size: half of an HD disk is twice half a DD one. */
export function shouldSnapshot(changedSectors: number, imageBytes: number = ADF_BYTES): boolean {
  return encodedSize(changedSectors) >= imageBytes * SNAPSHOT_THRESHOLD;
}
```

- [ ] **Step 4: chain.ts, version.ts, history.ts**

In `src/lib/disk-history/chain.ts` replace lines 1-2 with

```ts
import { applyDelta, decodeDelta, shouldSnapshot, isHistoryImage } from './delta';
import { ADF_BYTES } from '@/lib/adfmfm/constants';
```

replace `nextKind` with:

```ts
/** What the next version should be, given the write about to be recorded.
 *  `imageBytes` is the disk's size (HD writes spec §5.2). */
export function nextKind(
  changedSectors: number, deltasSinceSnapshot: number, imageBytes: number = ADF_BYTES,
): VersionKind {
  // Either reason is sufficient: a delta that no longer saves space, or a
  // chain that has grown long enough to make rewinding slow.
  if (shouldSnapshot(changedSectors, imageBytes)) return 'snapshot';
  if (deltasSinceSnapshot >= MAX_CHAIN_DEPTH) return 'snapshot';
  return 'delta';
}
```

and in `materialise` replace `if (image.length !== ADF_BYTES) {` with `if (!isHistoryImage(image)) {`.

Replace `src/lib/disk-history/version.ts` with:

```ts
import { ADF_BYTES, ADF_HD_BYTES, HD_TRACK_DATA_BYTES, TRACK_DATA_BYTES, TRACKS } from '@/lib/adfmfm/constants';
import { adfDensity } from '@/lib/disk-format';
import { buildDelta, encodeDelta } from './delta';
import { nextKind, deltasSinceSnapshot, type VersionEntry, type VersionKind } from './chain';

/**
 * Turning a write session into the next version of a disk (write-back spec
 * §3.4). Pure: the store (store.ts) does the I/O, this decides what to store.
 */

export interface StagedTrack { track: number; data: Uint8Array }

/** One track's sector data for an image of this size: 5,632 DD, 11,264 HD
 *  (HD writes spec §5.1). Null for any other size. */
export function trackBytesForImage(imageBytes: number): number | null {
  if (imageBytes === ADF_BYTES) return TRACK_DATA_BYTES;
  if (imageBytes === ADF_HD_BYTES) return HD_TRACK_DATA_BYTES;
  return null;
}

/** The same, from a disk row. An HFE takes no uploads (spec D2): null. */
export function trackBytesForDisk(d: { imageFormat: string; sizeBytes: number }): number | null {
  if (d.imageFormat !== 'adf') return null;
  const density = adfDensity(d.sizeBytes);
  if (density === 'hd') return HD_TRACK_DATA_BYTES;
  if (density === 'dd') return TRACK_DATA_BYTES;
  return null;
}

/** A track the board may upload: 0..159, exactly one track of `trackBytes`
 *  (this disk's size; DD unless told otherwise). */
export function isTrackUpload(track: number, data: Uint8Array, trackBytes: number = TRACK_DATA_BYTES): boolean {
  return Number.isInteger(track) && track >= 0 && track < TRACKS
    && data.length === trackBytes;
}

/** `head` with each staged track written over it, at the head's own track
 *  size. Does not modify `head`. */
export function overlayTracks(head: Uint8Array, tracks: readonly StagedTrack[]): Uint8Array {
  const trackBytes = trackBytesForImage(head.length);
  if (trackBytes === null) {
    throw new Error(`head must be ${ADF_BYTES} or ${ADF_HD_BYTES} bytes, got ${head.length}`);
  }
  const out = head.slice();
  for (const t of tracks) {
    if (!isTrackUpload(t.track, t.data, trackBytes)) throw new Error(`not a track upload: track ${t.track}`);
    out.set(t.data, t.track * trackBytes);
  }
  return out;
}

export interface PlannedVersion {
  kind: VersionKind;
  /** Sectors that differ from the previous version. */
  sectorCount: number;
  /** The encoded WDLD delta for a 'delta'; null for a 'snapshot' (the image is the blob). */
  deltaBlob: Uint8Array | null;
}

/** What to record for `next`, given the history so far. Null when nothing changed. */
export function planNextVersion(
  entries: readonly VersionEntry[], head: Uint8Array, next: Uint8Array,
): PlannedVersion | null {
  const delta = buildDelta(head, next);
  if (delta.sectors.length === 0) return null;
  const kind = nextKind(delta.sectors.length, deltasSinceSnapshot(entries), next.length);
  return {
    kind,
    sectorCount: delta.sectors.length,
    deltaBlob: kind === 'delta' ? encodeDelta(delta) : null,
  };
}
```

In `src/lib/disk-history/history.ts` delete line 2 (`import { ADF_BYTES } from '@/lib/adfmfm';`), change line 8 to `import { applyDelta, decodeDelta, isHistoryImage } from './delta';`, and replace `if (image.length !== ADF_BYTES) {` (line 197) with `if (!isHistoryImage(image)) {`. In the comment at line 21 change `up to 880 KB` to `up to 1.76 MB`.

- [ ] **Step 5: restore.ts refuses mixed sizes**

In `src/lib/disk-history/restore.ts`, directly after the `before = await diskStore.read(disk.sha256);` try/catch block (after line 113), add:

```ts
  // A disk's versions are all one size (HD writes spec §5.2). A target of the
  // other size is only reachable through hand-edited rows or blobs; refused
  // by name here rather than left to recordVersion's DeltaError as a 500.
  if (target.length !== before.length) return { ok: false, status: 409, reason: 'size_mismatch' };
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec vitest run src/lib/disk-history src/lib/adffs
pnpm exec tsc --noEmit -p .
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/disk-history/delta.ts src/lib/disk-history/chain.ts src/lib/disk-history/version.ts \
  src/lib/disk-history/history.ts src/lib/disk-history/restore.ts src/lib/disk-history/delta.test.ts \
  src/lib/disk-history/chain.test.ts src/lib/disk-history/version.test.ts src/lib/disk-history/history.test.ts \
  src/lib/disk-history/restore.test.ts
git commit -F- <<'EOF'
disk history: sector and track size from the image (DD or HD); mixed sizes refused

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 4: The write route takes 11,264-byte HD tracks

**Files:**
- Modify: `src/lib/device-write.ts:1-31` (imports, the `Outcome` doc), `:76-95` (`stageTrack`'s checks)
- Test: `e2e/hd-disks.spec.ts` (replace the test `the board is refused a write to an HD disk, in the words its uploader acts on`), `e2e/device-write.spec.ts` (one new test)

**Interfaces:**
- Consumes: Task 3's `trackBytesForDisk`, `isTrackUpload(track, data, trackBytes)`, size-aware `overlayTracks`.
- Produces: `POST /api/device/write` accepts 5,632 bytes for a DD disk and 11,264 for an HD disk, `400 invalid_body` otherwise; `closeSession` records an HD image. The route file (`src/app/api/device/write/route.ts`) is unchanged.

- [ ] **Step 1: Read the route-handler guide**

Run: `sed -n 1,80p node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` (AGENTS.md; no route file changes here, but the e2e drives one).

- [ ] **Step 2: Write the failing e2e tests**

In `e2e/hd-disks.spec.ts` change the imports to:

```ts
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { diskVersions, diskWriteTracks } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { HD_TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, pairDevice, authHeader } from './device-helpers';
```

and replace the whole test `the board is refused a write to an HD disk, in the words its uploader acts on` with:

```ts
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function upload(request: APIRequestContext, token: string,
                q: { diskId: string; mount: number; track: number; seq: number }, data: Uint8Array) {
  return request.post(
    `/api/device/write?disk=${q.diskId}&mount=${q.mount}&track=${q.track}&session=boot-1&seq=${q.seq}`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.from(data) });
}

test('a board writes an HD disk: 11,264-byte tracks, a close, a version with 22 sectors changed', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `HDW${runTag().slice(0, 8)}`, density: 'hd' });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, {
    title: `HD Write ${runTag()}`, diskNo: 1, sha256: original, sizeBytes: HD_BYTES, writeProtected: false,
  });
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, playsHd: true } })).status()).toBe(204);
  const { version: mount } = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: original, mountedDiskId: diskId, version: mount } })).status()).toBe(204);

  // Review Focus 1: a DD track's 5,632 bytes on an HD disk would overlay at
  // the wrong offset. Refused, and nothing staged.
  const dd = await upload(request, token, { diskId, mount, track: 0, seq: 1 }, new Uint8Array(5_632));
  expect(dd.status()).toBe(400);
  expect((await dd.json()).error).toBe('invalid_body');
  expect(await getDb().select().from(diskWriteTracks).where(eq(diskWriteTracks.deviceId, deviceId))).toEqual([]);

  // The last track: its bytes are the last 11,264 of the image (Review Focus 4).
  const written = new Uint8Array(HD_TRACK_DATA_BYTES).fill(0x5a);
  const up = await upload(request, token, { diskId, mount, track: 159, seq: 2 }, written);
  expect(up.status()).toBe(200);

  const expected = adf.slice();
  expected.set(written, 159 * HD_TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${diskId}&mount=${mount}&session=boot-1&seq=2&sha256=${want}`,
    { headers: authHeader(token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  const rows = await getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, diskId)).orderBy(asc(diskVersions.seq));
  expect(rows.map((r) => [r.seq, r.source])).toEqual([[0, 'original'], [1, 'amiga']]);
  expect(rows[1].sectorCount).toBe(22);
  const [disk] = await getDb().select().from(disks).where(eq(disks.id, diskId));
  expect(disk.sha256).toBe(want);
  expect(disk.sizeBytes).toBe(HD_BYTES);

  // The new head goes back to the board as WFAD, like any HD disk.
  const img = await request.get(`/api/device/image/${want}`, { headers: authHeader(token) });
  expect(img.status()).toBe(200);
  expect(img.headers()['content-length']).toBe('1802256');
});
```

(Keep `fakeSha` and `hdAdf` where they are; other tests use them. `Page` stays imported for `uploadViaApi`.)

In `e2e/device-write.spec.ts` change the `@/lib/adfmfm` import to `import { TRACK_DATA_BYTES, HD_TRACK_DATA_BYTES } from '@/lib/adfmfm';` and add after the test `a short body and a bad query are 400s`:

```ts
test("an HD track's 11,264 bytes on a DD disk are a 400, and nothing is staged (Review Focus 1)", async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const res = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 0, seq: 1 },
                           new Uint8Array(HD_TRACK_DATA_BYTES));
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe('invalid_body');
  expect(await getDb().select().from(diskWriteTracks)
    .where(eq(diskWriteTracks.deviceId, m.deviceId))).toEqual([]);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `PORT=3100 pnpm exec playwright test e2e/hd-disks.spec.ts e2e/device-write.spec.ts --reporter=line`
Expected: the new HD test FAILs (the 11,264-byte upload answers 400: `isTrackUpload` only knows 5,632); the new DD test passes already (it pins behaviour that must not change). Every other test passes.

- [ ] **Step 4: Implement**

In `src/lib/device-write.ts`:
- Replace the imports on lines 7 and 10 with:

```ts
import { HD_TRACK_DATA_BYTES, TRACK_DATA_BYTES } from '@/lib/adfmfm/constants';
```

and

```ts
import { overlayTracks, isTrackUpload, trackBytesForDisk } from '@/lib/disk-history/version';
```

(`isHdAdf` is no longer imported.)
- In the `Outcome` doc comment replace `| 400 invalid_body | 404 not_found | 409 not_mounted | 409 { not_mounted, reason: 'behind' } | 409 write_protected (with an open session only for an HD disk, as { write_protected, reason: 'hd_read_only' }; otherwise only when opening one).` with `| 400 invalid_body (not 5,632 bytes for a DD disk / 11,264 for an HD one) | 404 not_found | 409 not_mounted | 409 { not_mounted, reason: 'behind' } | 409 write_protected (only when opening a session).`
- Replace `stageTrack`'s first line (`if (!isTrackUpload(q.track, data)) return …`) with:

```ts
  // A body that is no disk's track at all is refused before any query. Which
  // of the two sizes THIS disk takes is decided once its row is read, below.
  if (!isTrackUpload(q.track, data, TRACK_DATA_BYTES) && !isTrackUpload(q.track, data, HD_TRACK_DATA_BYTES)) {
    return { status: 400, body: { error: 'invalid_body' } };
  }
```

- Replace the HD refusal block (the comment starting `// HD spec §4.3: read-only on the Amiga in this release.` and the `if (isHdAdf(disk)) return …` line) with:

```ts
  // HD writes spec §5.1: 5,632 bytes for a DD disk, 11,264 for an HD one. The
  // other density's size is refused, never overlaid -- it would land at the
  // wrong offset and shift every byte after it. An HFE (trackBytesForDisk:
  // null) skips this and meets the write_protected refusal below, exactly as
  // before.
  const trackBytes = trackBytesForDisk(disk);
  if (trackBytes !== null && data.length !== trackBytes) {
    return { status: 400, body: { error: 'invalid_body' } };
  }
```

`closeSession` needs no edit: `overlayTracks(base, staged)` now overlays at the base image's own track size.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec tsc --noEmit -p . && pnpm lint
PORT=3100 pnpm exec playwright test e2e/hd-disks.spec.ts e2e/device-write.spec.ts e2e/disk-history.spec.ts --reporter=line
```

Expected: all pass. Stop the dev server you started on 3100 by its PID only.

- [ ] **Step 6: Commit**

```bash
git add src/lib/device-write.ts e2e/hd-disks.spec.ts e2e/device-write.spec.ts
git commit -F- <<'EOF'
write route: HD tracks are 11,264 bytes; the other density's size is a 400

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 5: The server stops refusing HD edits

**Files:**
- Modify: `src/lib/mount.ts:181-182,230-237` (readDesired), `src/app/api/disks/[id]/route.ts:1-9,30-49` (PATCH), `src/lib/disk-write.ts:28,62-69,81-88`, `src/lib/disk-history/restore.ts:15,47-54,70-72`, `src/app/api/disks/[id]/volume-name/route.ts:7,60-63,80-84`, `src/app/api/disks/[id]/files/batch/route.ts:12,132,144-146`, `src/app/api/disks/[id]/files/[block]/route.ts:11-12,77,84-86,187,201,218,257`, `src/app/api/disks/[id]/files/route.ts:3,71-75`
- Test: `src/lib/mount-hd.test.ts:65-80`, `src/lib/disk-write.test.ts:309-321`, `src/lib/disk-history/restore.test.ts` (one new test), `e2e/hd-disks.spec.ts` (tests 2 and 3)

**Interfaces:**
- Consumes: Task 1's `readVolume(...).rootBlock`; Task 3's `size_mismatch`.
- Produces: `readDesired` sends an HD disk's `writeProtected` as the row has it; the write-protect PATCH, `applyDiskEdit`, `restoreVersion`, volume rename, file add/mkdir/rename/move/delete/batch and file download all accept HD; every route names the root by `volume.rootBlock`.

- [ ] **Step 1: Read the route-handler guide**

Run: `sed -n 1,120p node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

- [ ] **Step 2: Write the failing unit tests**

In `src/lib/mount-hd.test.ts` replace the `describe('readDesired and HD (spec §4.3)', …)` block with:

```ts
describe('readDesired and HD (HD writes spec §5.3)', () => {
  const row = {
    version: 5, sha256: 'a'.repeat(64), diskId: 'disk-hd', gameId: 'g1', diskNo: 1,
    title: 'T', label: 'L', diskCount: 1,
  };

  it("sends an HD disk's flag as the library has it", async () => {
    selects = [[{ ...row, writeProtected: false }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(false);
    selects = [[{ ...row, writeProtected: true }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(true);
  });

  it('still sends a disk whose row has gone missing as protected', async () => {
    selects = [[{ ...row, writeProtected: null }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(true);
  });
});
```

In `src/lib/disk-write.test.ts` replace the test `refuses an HD disk by name before reading a byte (HD spec §4.2)` with:

```ts
  it('edits an HD disk like any other (HD writes spec §6.2)', async () => {
    const before = new Uint8Array([1, 2, 3]);
    const after = new Uint8Array([4, 5, 6]);
    const newSha = createHash('sha256').update(after).digest('hex');
    selectResults = [[{ ...DISK_ROW, imageFormat: 'adf', sizeBytes: 1_802_240 }], []];
    diskStoreRead.mockResolvedValue(before);
    recordVersion.mockResolvedValue({ sha256: newSha, seq: 1, kind: 'delta', sectorCount: 1 });

    const { applyDiskEdit } = await import('@/lib/disk-write');
    const result = await applyDiskEdit(ORG_ID, DISK_ID, () => ({ ok: true, adf: after }));

    expect(result).toEqual({ ok: true, sha256: newSha });
    expect(recordVersion).toHaveBeenCalledTimes(1);
  });
```

In `src/lib/disk-history/restore.test.ts` add inside `describe('restoreVersion', …)`:

```ts
  it('restores an HD version like a DD one (HD writes spec §5.2)', async () => {
    const { recordVersion } = await import('./store');
    let head = formatVolume({ filesystem: 'FFS', volumeName: 'HDChain', density: 'hd' });
    blobBytes.set(sha256Of(head), head);
    const images = [head];
    for (const name of ['A', 'B']) {
      const r = addFile(head, 1760, name, new TextEncoder().encode(name));
      if (!r.ok) throw new Error(`fixture: ${r.reason}`);
      await recordVersion({
        orgId: ORG, diskId: DISK, headSha: sha256Of(head), head, next: r.adf,
        source: 'browser', userId: 'user-1', sourceFilename: 'HDChain.adf',
      });
      head = r.adf;
      images.push(head);
    }
    diskLookupResult = [{
      sha256: sha256Of(images[2]), tosecName: 'HDChain.adf', sourceFilename: 'HDChain.adf',
      imageFormat: 'adf', sizeBytes: 1_802_240,
    }];

    const { restoreVersion } = await import('./restore');
    expect(await restoreVersion(ORG, DISK, 1, 'user-2'))
      .toEqual({ ok: true, sha256: sha256Of(images[1]), seq: 3, recorded: true });
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run src/lib/mount-hd.test.ts src/lib/disk-write.test.ts src/lib/disk-history/restore.test.ts`
Expected: FAIL — readDesired sends `true` for the writable HD row; `applyDiskEdit` answers `hd_read_only`; `restoreVersion` answers `hd_read_only`.

- [ ] **Step 4: readDesired and the write-protect PATCH**

In `src/lib/mount.ts` `readDesired`: delete the two select lines `imageFormat: disks.imageFormat,` and `sizeBytes: disks.sizeBytes,` (lines 181-182), and replace the `writeProtected:` entry (lines 230-237 with its comment) with:

```ts
      // A disk row that has gone missing is not a licence to allow writes.
      // HD follows the row like DD (HD writes spec §5.3); a board on 1.4.1
      // still holds WPROT for HD itself until it updates (§5.4).
      writeProtected: r.writeProtected ?? true,
```

(`isHdAdf` stays imported: `setDesired` still uses it for the `hd_unsupported` gate.)

In `src/app/api/disks/[id]/route.ts` change line 2 to `import { and, eq, ne, sql } from 'drizzle-orm';`, delete the `isHdAdf` and `isHdAdfSql` imports (lines 8-9), and replace the block from `// An HFE is always write-protected (spec D2), and so is an HD disk` down to `return Response.json({ error: 'not_found' }, { status: 404 });` + its closing brace with:

```ts
  // An HFE is always write-protected (spec D2). Refused here, not only hidden
  // in the UI: a direct call must not be able to make one writable. The
  // format is a condition of the UPDATE itself, not a SELECT before it: a
  // concurrent /complete can flip this row to 'hfe' between the two.
  // Org-scoped in the statement, not in a WHERE a later edit could drop. An
  // HD disk is an ordinary disk here (HD writes spec §5.3).
  const scope = and(eq(disks.id, id), eq(disks.orgId, orgId));
  const updated = await getDb().update(disks)
    .set({ writeProtected: parsed.data.writeProtected })
    .where(parsed.data.writeProtected ? scope : and(scope, ne(disks.imageFormat, 'hfe')))
    .returning({ id: disks.id, writeProtected: disks.writeProtected });

  if (updated.length === 0) {
    // Nothing updated: no such disk in this org, or an HFE refused.
    const row = await getDb().select({ imageFormat: disks.imageFormat })
      .from(disks).where(scope).limit(1);
    if (row[0]?.imageFormat === 'hfe') return Response.json({ error: 'hfe_read_only' }, { status: 409 });
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
```

- [ ] **Step 5: applyDiskEdit, restore, volume rename, batch**

`src/lib/disk-write.ts`: delete the `isHdAdf` import (line 28), delete `sizeBytes: disks.sizeBytes,` from the select, and delete the HD block (the comment `// HD spec §4.2: no browser editing of an HD disk in this release …` and `if (isHdAdf(disk)) return { ok: false, status: 409, reason: 'hd_read_only' };`).

`src/lib/disk-history/restore.ts`: delete the `isHdAdf` import (line 15), delete `sizeBytes: disks.sizeBytes,` from the select, and delete the HD block (`// HD spec §4.2: an HD disk has no browser history …` and its `if (isHdAdf(disk)) …` line).

`src/app/api/disks/[id]/volume-name/route.ts`: delete the `isHdAdf` import (line 7), change the select line `imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes,` to `imageFormat: disks.imageFormat,` (the HFE check still reads `imageFormat`), and delete the block `// HD spec §4.2: a rename rewrites the volume through adffs, …` with its `if (isHdAdf(disk)) { … }`. `setVolumeName` finds the HD root itself (Task 1).

`src/app/api/disks/[id]/files/batch/route.ts`: delete the `isHdAdf` import (line 12); change the select to `.select({ sha256: disks.sha256 })`; delete the block `// HD spec §4.2: refused by name BEFORE the 1.8 MB read, …` and its `if (isHdAdf(disk)) …` line. (`applyBatch` seeds its `''` parent with the image's own root, Task 1.)

- [ ] **Step 6: The file routes name the root by `volume.rootBlock`**

`src/app/api/disks/[id]/files/route.ts`: delete `import { ROOT_BLOCK } from '@/lib/adffs/constants';` and replace the check inside `edit` with:

```ts
    // The root itself (880 DD, 1,760 HD -- volume.rootBlock) is never an entry
    // in `volume.root`: it IS that array, so it is accepted without walking
    // for it. Any other number, including a DD root sent to an HD disk
    // (Review Focus 2), must be a directory found in the parsed tree.
    if (parentBlock !== volume.rootBlock && !isDirectory(volume.root, parentBlock)) {
      return { ok: false, reason: 'not-a-directory' };
    }
```

`src/app/api/disks/[id]/files/[block]/route.ts`:
- Delete the `isHdAdf` and `ROOT_BLOCK` imports (lines 11-12).
- In `GET`, change the select to `.select({ sha256: disks.sha256 })` and delete the block `// HD spec §4.2: "HD disks can't be browsed in the browser yet" …` with its `if (isHdAdf(disk)) …` line.
- In the move branch replace `findEntryWithParent(volume.root, blockNo, ROOT_BLOCK)` with `findEntryWithParent(volume.root, blockNo, volume.rootBlock)` and `if (toParent !== ROOT_BLOCK) {` with `if (toParent !== volume.rootBlock) {`.
- In the rename branch and in `DELETE`, replace `findEntryWithParent(volume.root, blockNo, ROOT_BLOCK)` with `findEntryWithParent(volume.root, blockNo, volume.rootBlock)`.
- In the doc comment of `findEntryWithParent`, change `walk down from ROOT_BLOCK` to `walk down from the volume's root block`.

- [ ] **Step 7: Run the unit tests**

```bash
pnpm exec vitest run src/lib
pnpm exec tsc --noEmit -p . && pnpm lint
grep -rn "hd_read_only\|hd_not_browsable\|isHdAdfSql" src --include=*.ts --include=*.tsx | grep -v "\.test\."
```

Expected: vitest and the type/lint checks pass. The grep lists only `src/components/disks/file-actions.tsx` (its `hd_read_only` case, removed in Task 6), `src/lib/disk-format-sql.ts` (the definition) and `src/lib/queries.ts` (the library's HD tag).

- [ ] **Step 8: Update the e2e tests**

In `e2e/hd-disks.spec.ts`:
- In the test `an HD disk mounts only on a board reporting playsHd, always goes write-protected, and is served as WFAD`, rename it to `an HD disk mounts only on a board reporting playsHd, follows the library's write-protect flag, and is served as WFAD`, change the comment above `await getDb().update(disks).set({ writeProtected: false })…` to `// The row is writable: the board is told so (HD writes spec §5.3).`, and change `expect(poll.desired).toMatchObject({ sha256, diskId: d.id, writeProtected: true });` to `expect(poll.desired).toMatchObject({ sha256, diskId: d.id, writeProtected: false });`.
- Replace the whole test `every write path refuses an HD disk by name, before reading a byte` with:

```ts
test('every browser write path works on an HD disk, whose root is block 1760', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  // A fixed timestamp: the same bytes every run, so the blob store dedupes it.
  const bytes = Buffer.from(formatVolume({
    filesystem: 'FFS', volumeName: 'HDEdit', density: 'hd', now: new Date(Date.UTC(2026, 8, 27)),
  }));
  await uploadViaApi(page, bytes, 'HD Edit (2026)(Webadf).adf');
  const [d] = await getDb().select({ id: disks.id, sha256: disks.sha256 }).from(disks).where(eq(disks.orgId, orgId));

  const off = await page.request.patch(`/api/disks/${d.id}`, { data: { writeProtected: false } });
  expect(off.status()).toBe(200);
  expect((await off.json()).writeProtected).toBe(false);

  // Review Focus 2: a page that still says 880 is not naming a directory here.
  const stale = await page.request.post(`/api/disks/${d.id}/files`, { multipart: { parentBlock: '880', name: 'X' } });
  expect(stale.status()).toBe(400);
  expect(await stale.json()).toMatchObject({ error: 'edit_failed', reason: 'not-a-directory' });
  expect((await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, d.id)))[0].sha256).toBe(d.sha256);

  expect((await page.request.post(`/api/disks/${d.id}/files`, {
    multipart: { parentBlock: '1760', name: 'DIR' },
  })).status()).toBe(200);
  expect((await page.request.post(`/api/disks/${d.id}/files`, {
    multipart: {
      parentBlock: '1760', name: 'HELLO.TXT',
      file: { name: 'HELLO.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from('hello hd') },
    },
  })).status()).toBe(200);

  const adf = new Uint8Array(await (await page.request.get(`/api/disks/${d.id}/adf`)).body());
  expect(adf.length).toBe(HD_BYTES);
  const v = readVolume(adf);
  if (!v.ok) throw new Error(`expected a volume, got ${v.reason}`);
  expect(v.rootBlock).toBe(1760);
  const hello = v.root.find((e) => e.name === 'HELLO.TXT')!;
  const dir = v.root.find((e) => e.name === 'DIR')!;

  const got = await page.request.get(`/api/disks/${d.id}/files/${hello.block}`);
  expect(got.status()).toBe(200);
  expect((await got.body()).toString()).toBe('hello hd');

  // A stale DD root as a move target is not found here either.
  const staleMove = await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { toParent: 880 } });
  expect(staleMove.status()).toBe(400);

  expect((await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { name: 'RENAMED.TXT' } })).status()).toBe(200);
  expect((await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { toParent: dir.block } })).status()).toBe(200);
  expect((await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { toParent: 1760 } })).status()).toBe(200);
  expect((await page.request.patch(`/api/disks/${d.id}/volume-name`, { data: { volumeName: 'HDRenamed' } })).status()).toBe(200);
  expect((await page.request.delete(`/api/disks/${d.id}/files/${dir.block}`)).status()).toBe(200);

  // Version 1 is the disk right after DIR was made: DIR, and no HELLO.TXT.
  const restore = await page.request.post(`/api/disks/${d.id}/restore`, { data: { seq: 1 } });
  expect(restore.status()).toBe(200);
  const back = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${d.id}/adf`)).body()));
  if (!back.ok) throw new Error(`expected a volume, got ${back.reason}`);
  expect(back.root.map((e) => e.name)).toEqual(['DIR']);
});
```

and add `import { readVolume } from '@/lib/adffs';` to the imports.

- [ ] **Step 9: Run the e2e**

Run: `PORT=3100 pnpm exec playwright test e2e/hd-disks.spec.ts e2e/disk-files-edit.spec.ts e2e/time-machine.spec.ts --reporter=line`
Expected: `hd-disks.spec.ts`'s first test still FAILS (the toggle is still locked until Task 6); every other test passes. Stop your dev server by its PID only.

- [ ] **Step 10: Commit**

```bash
git add src/lib/mount.ts src/lib/mount-hd.test.ts "src/app/api/disks/[id]/route.ts" src/lib/disk-write.ts \
  src/lib/disk-write.test.ts src/lib/disk-history/restore.ts src/lib/disk-history/restore.test.ts \
  "src/app/api/disks/[id]/volume-name/route.ts" "src/app/api/disks/[id]/files/batch/route.ts" \
  "src/app/api/disks/[id]/files/[block]/route.ts" "src/app/api/disks/[id]/files/route.ts" e2e/hd-disks.spec.ts
git commit -F- <<'EOF'
server: HD disks are writable and editable; routes name the root by volume.rootBlock

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 6: The browser opens and edits HD disks

**Files:**
- Modify: `src/lib/hd-messages.ts`, `src/components/disks/file-actions.tsx:7,10,58,63-66,102-120,~185-200,252,283,301`, `src/components/disks/file-tree.tsx:21,125,195,321,331,385-386,453`, `src/components/disks/drop-staging.tsx:11,76,111,114`, `src/app/(app)/disks/[id]/files/page.tsx:24-25,118-119,144-192,345-356`, `src/components/disks/volume-header.tsx:20`, `src/components/games/disk-row.tsx:13-14,34,145-148`, `src/components/games/write-protect-toggle.tsx`, `src/lib/drive-chips.ts:4,36-40,91-94`
- Test: `src/lib/drive-chips.test.ts:73-78`, `e2e/hd-disks.spec.ts` (test 1)

**Interfaces:**
- Consumes: Task 1's `readVolume(...).rootBlock`, `DD_GEOMETRY`; Task 5's routes.
- Produces: `FileEditProvider` takes `rootBlock: number`; `useFileEdit()` returns `{ diskId, disabled, busy, runEdit, rootBlock }`. `WriteProtectToggle` has no `locked` prop. `DriveChipDisk.readOnly: 'HFE' | null`. `hd-messages.ts` exports only `HD_UNSUPPORTED`.

- [ ] **Step 1: Read the page guide**

Run: `sed -n 1,120p node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`

- [ ] **Step 2: Write the failing tests**

In `src/lib/drive-chips.test.ts` replace the test `an HD disk reads WP, says why, and cannot be toggled (HD spec §4.3)` with:

```ts
  it("an HD disk follows its library flag like a DD disk (HD writes spec §5.3)", () => {
    const c = chip({ ...loaded, mountedSizeBytes: 1_802_240, mountedDiskWriteProtected: false });
    expect(c.disk?.readOnly).toBeNull();
    expect(protectTag(c)).toBe('RW');
    expect(c.canToggleProtect).toBe(true);
  });
```

In `e2e/hd-disks.spec.ts` replace the first test (`an uploaded HD ADF is tagged HD everywhere its size shows, cannot be made writable, and the file browser says why`) with:

```ts
test('an uploaded HD ADF is tagged HD, can be made writable, and opens in the file browser', async ({ page }) => {
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
  // Protected by default like every disk, and now a real toggle (HD writes spec §5.3).
  await expect(wp).toHaveAttribute('data-protected', 'true');
  await expect(wp).not.toHaveAttribute('data-locked', 'true');
  await expect(wp).toBeEnabled();
  await wp.click();
  await expect(wp).toHaveAttribute('data-protected', 'false');

  await page.goto('/library?view=table');
  await expect(page.getByTestId('game-hd-tag')).toBeVisible();

  await page.goto(`/disks/${d.id}/files`);
  await expect(page.getByTestId('hd-not-browsable')).toHaveCount(0);
  // These bytes are noise with no DOS signature: the ordinary "no filesystem"
  // answer any such disk gets, not a refusal because it is HD.
  await expect(page.getByTestId('file-edit-disabled')).toContainText('no filesystem');
});
```

- [ ] **Step 3: Run them to verify they fail**

```bash
pnpm exec vitest run src/lib/drive-chips.test.ts
PORT=3100 pnpm exec playwright test e2e/hd-disks.spec.ts -g "opens in the file browser" --reporter=line
```

Expected: vitest FAILs (`readOnly` is `'HD'`); the e2e FAILs at `not.toHaveAttribute('data-locked', 'true')`.

- [ ] **Step 4: Messages, the toggle, the disk row, the chips**

Replace `src/lib/hd-messages.ts` with:

```ts
// Every sentence a person reads about an HD disk (HD spec §4.3). The spec's
// words verbatim; tests compare against this constant, so copy changes happen
// here. HD disks are otherwise ordinary disks since the HD writes spec
// (2026-09-27): nothing else about them needs saying.

export const HD_UNSUPPORTED = "Update the drive's firmware to play HD disks";
```

Replace `src/components/games/write-protect-toggle.tsx` lines 7-18 with:

```tsx
export function WriteProtectToggle({ diskId, writeProtected }: {
  diskId: string; writeProtected: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
```

and the returned `<button …>` opening tag and its `title` with (the title copy is unchanged):

```tsx
    <button type="button" onClick={onToggle} disabled={busy}
            data-testid={`wp-${diskId}`} data-protected={writeProtected ? 'true' : 'false'}
            aria-pressed={writeProtected}
            title={writeProtected
              ? 'Write protected — the device will refuse writes'
              : 'Writable — the device may write to this disk once write-back ships'}
```

and replace every remaining `shownProtected` in the file with `writeProtected`.

In `src/components/games/disk-row.tsx` delete only the `HD_READ_ONLY` import (line 14); `isHdAdf`, `const isHd` and the `HdTag` line stay (the HD tag is still shown). Replace

```tsx
          <WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected}
                              locked={isHd ? HD_READ_ONLY : undefined} />
```

with

```tsx
          <WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected} />
```

In `src/lib/drive-chips.ts` delete `import { adfDensity } from '@/lib/disk-format';`, replace the `readOnly` doc and type (lines 36-40) with:

```ts
  /**
   * Why this disk can never be made writable, or null: an HFE (spec D2). The
   * PATCH refuses to unprotect one. HD disks are ordinary here (HD writes
   * spec §5.3).
   */
  readOnly: 'HFE' | null;
```

and the `readOnly:` entry in `toDriveChip` with `readOnly: r.mountedImageFormat === 'hfe' ? 'HFE' : null,`.

- [ ] **Step 5: The root block reaches the file browser's controls**

In `src/components/disks/file-actions.tsx`:
- Delete `import { ROOT_BLOCK } from '@/lib/adffs/constants';` and `import { HD_READ_ONLY } from '@/lib/hd-messages';`, and the line `case 'hd_read_only': return HD_READ_ONLY;` in `describeEditError`.
- Add to `interface FileEditContextValue`, after `disabled: EditDisabled | null;`:

```ts
  /** The disk's root directory block: 880 DD, 1,760 HD (HD writes spec §6.1).
   *  Every control that means "the root" sends this, never a constant. */
  rootBlock: number;
```

- Change `FileEditProvider`'s destructuring to `diskId, disabled, tosecName, rootBlock, children,` and add to its props type, after `tosecName: string | null;`:

```ts
  /** From readVolume's `rootBlock` (page.tsx). */
  rootBlock: number;
```

- Change `<FileEditContext.Provider value={{ diskId, disabled, busy, runEdit }}>` to `<FileEditContext.Provider value={{ diskId, disabled, busy, runEdit, rootBlock }}>`.
- In `FileToolbar` change `const { diskId, disabled, busy, runEdit } = useFileEdit();` to `const { diskId, disabled, busy, runEdit, rootBlock } = useFileEdit();` and both `form.set('parentBlock', String(ROOT_BLOCK));` to `form.set('parentBlock', String(rootBlock));`. In its doc comment change `(block 880)` to `(block 880 on a DD disk, 1,760 on an HD one)`.

In `src/components/disks/file-tree.tsx`:
- Delete `import { ROOT_BLOCK } from '@/lib/adffs/constants';`.
- Change `const { disabled, busy, runEdit } = useFileEdit();` to `const { disabled, busy, runEdit, rootBlock } = useFileEdit();`.
- Replace every remaining `ROOT_BLOCK` in the file with `rootBlock`, and add `rootBlock` to the two `useMemo` dependency arrays that now use it: `[entries]` becomes `[entries, rootBlock]` for `directoryOptions` and `parentBlocks`. In the comment near line 125, `(\`ROOT_BLOCK\` for anything at the top level)` becomes `(the disk's root block for anything at the top level)`.

In `src/components/disks/drop-staging.tsx`:
- Delete `import { ROOT_BLOCK } from '@/lib/adffs/constants';`.
- Change line 76 to `const { diskId, disabled, busy, runEdit, rootBlock } = useFileEdit();`.
- Change `() => [{ block: ROOT_BLOCK, label: '/' }, ...collectDirectories(entries)],` / `[entries],` to `() => [{ block: rootBlock, label: '/' }, ...collectDirectories(entries)],` / `[entries, rootBlock],`, and `useState<number>(ROOT_BLOCK)` to `useState<number>(rootBlock)`.

In `src/components/disks/volume-header.tsx` change the `'not-adf'` copy to `'This image is not a standard 880 KB or 1.76 MB ADF.'`.

In `src/app/(app)/disks/[id]/files/page.tsx`:
- Replace the imports on lines 12, 24 and 25 with `import { readVolume, readUsage, DD_GEOMETRY, type AdfEntry } from '@/lib/adffs';` (delete the `isHdAdf` and `HD_NOT_BROWSABLE` imports).
- Delete `sizeBytes: disks.sizeBytes,` from the select (keep `imageFormat`: the HFE redirect reads it).
- Delete the HD block (the comment `// HD spec §4.2: adffs reads one geometry today, …` and `const hd = isHdAdf(disk);`).
- Replace `let bytes: Uint8Array | null = null;` and the `if (!hd) { … }` around the read with:

```tsx
  let bytes: Uint8Array | null = null;
  try {
    bytes = historicalSeq !== null && historyEntries
      ? await materialise(historyEntries, historicalSeq, (sha256) => diskStore.read(sha256))
      : await diskStore.read(disk.sha256);
  } catch {
    bytes = null;
  }
```

- Directly after `const volume = bytes ? readVolume(bytes) : null;` add:

```tsx
  // 880 DD, 1,760 HD. When there is no filesystem every edit is refused
  // anyway (`disabled` below), so the DD value is only a placeholder there.
  const rootBlock = volume?.ok ? volume.rootBlock : DD_GEOMETRY.rootBlock;
```

- Replace the `{hd ? ( … ) : volume === null ? (` opening of the conditional with `{volume === null ? (` (delete the `hd-not-browsable` branch), and change `<FileEditProvider diskId={id} disabled={disabled} tosecName={matchedTosecName}>` to `<FileEditProvider diskId={id} disabled={disabled} tosecName={matchedTosecName} rootBlock={rootBlock}>`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec vitest run src/lib
pnpm exec tsc --noEmit -p . && pnpm lint
grep -rn "hd_read_only\|hd_not_browsable\|HD_READ_ONLY\|HD_NOT_BROWSABLE\|ROOT_BLOCK" src --include=*.tsx
PORT=3100 pnpm exec playwright test e2e/hd-disks.spec.ts e2e/disk-files-edit.spec.ts e2e/disk-drag-drop.spec.ts e2e/adf-browser.spec.ts --reporter=line
```

Expected: vitest, tsc and lint pass; the grep prints nothing; every e2e test passes (the DD file browser, drag and drop, and the HD tests). Stop your dev server by its PID only.

- [ ] **Step 7: Commit**

```bash
git add src/lib/hd-messages.ts src/components/disks/file-actions.tsx src/components/disks/file-tree.tsx \
  src/components/disks/drop-staging.tsx "src/app/(app)/disks/[id]/files/page.tsx" src/components/disks/volume-header.tsx \
  src/components/games/disk-row.tsx src/components/games/write-protect-toggle.tsx src/lib/drive-chips.ts \
  src/lib/drive-chips.test.ts e2e/hd-disks.spec.ts
git commit -F- <<'EOF'
browser: HD disks open and edit in the file browser; write-protect toggles like DD

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 7: Blank HD disks

**Files:**
- Modify: `src/app/api/disks/create/route.ts:15-20,47-52,125`, `src/components/library/create-adf.tsx:40-57,88-93`, `e2e/helpers.ts:108-111`
- Test: `e2e/create-adf.spec.ts` (one new test), `e2e/hd-disks.spec.ts` (one new test)

**Interfaces:**
- Consumes: Task 1's `formatVolume({ density })`, Task 5-6's editable HD disks.
- Produces: `POST /api/disks/create` accepts `density: 'dd' | 'hd'` (default `'dd'`) and answers it back. Menu items `create-adf-hd-ffs` and `create-adf-hd-ofs`. `createAdf(page, filesystem = 'FFS', density: 'dd' | 'hd' = 'dd')`.

- [ ] **Step 1: Read the route-handler guide**

Run: `sed -n 1,120p node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

- [ ] **Step 2: Write the failing e2e tests**

In `e2e/helpers.ts` replace `createAdf` with:

```ts
export async function createAdf(page: Page, filesystem: 'FFS' | 'OFS' = 'FFS', density: 'dd' | 'hd' = 'dd') {
  await page.getByTestId('create-adf').click();
  await page.getByTestId(`create-adf-${density === 'hd' ? 'hd-' : ''}${filesystem.toLowerCase()}`).click();
}
```

In `e2e/create-adf.spec.ts` add after the test `OFS is selectable, and it really is OFS on the disk`:

```ts
test('an HD disk is 1.76 MB with its root at block 1760, and DD stays the default', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');

  await createAdf(page, 'FFS', 'hd');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  expect(disk.sizeBytes).toBe(1_802_240);

  const adf = await page.request.get(`/api/disks/${disk.id}/adf`);
  expect(adf.status()).toBe(200);
  const v = readVolume(new Uint8Array(await adf.body()));
  if (!v.ok) throw new Error(`expected a volume, got ${v.reason}`);
  expect(v.rootBlock).toBe(1760);
  expect(v.volume.filesystem).toBe('FFS');
  expect(v.root).toEqual([]);

  // The API's default is still DD.
  const res = await page.request.post('/api/disks/create', { data: {} });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.density).toBe('dd');
  const [dd] = await getDb().select().from(disks).where(eq(disks.id, body.diskId));
  expect(dd.sizeBytes).toBe(901_120);
});
```

In `e2e/hd-disks.spec.ts` add `createAdf` to the `./helpers` import, add `import { and } from 'drizzle-orm';` alongside `asc, eq` (so the line reads `import { and, asc, eq } from 'drizzle-orm';`), add `games` to the catalog import (`import { disks, games } from '@/db/schema/catalog';`), and append:

```ts
test('a blank HD disk is made, edited in the browser, and its history lists and restores the changes', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page, 'FFS', 'hd');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games).where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  expect(disk.sizeBytes).toBe(HD_BYTES);

  const AFTER_EDIT = { timeout: 15_000 };
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('file-toolbar')).toBeVisible();
  await expect(page.getByTestId('file-edit-disabled')).toHaveCount(0);

  // Through the toolbar: it must post the HD root, 1760.
  await page.getByTestId('upload-input').setInputFiles({
    name: 'HELLO.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from('hello hd'),
  });
  await expect(page.getByTestId('upload-name')).toHaveValue('HELLO.TXT');
  await page.getByTestId('upload-submit').click();
  const row = page.locator('[data-testid="fs-entry"][data-name="HELLO.TXT"]');
  await expect(row).toBeVisible(AFTER_EDIT);

  const v = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body()));
  if (!v.ok) throw new Error(`expected a volume, got ${v.reason}`);
  const block = v.root.find((e) => e.name === 'HELLO.TXT')!.block;
  await page.getByTestId(`fs-rename-${block}`).click();
  await page.getByTestId(`fs-rename-name-${block}`).fill('NEWNAME.TXT');
  await page.getByTestId(`fs-rename-submit-${block}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="NEWNAME.TXT"]')).toBeVisible(AFTER_EDIT);

  // History: file-level changes, newest first (HD writes spec §5.2).
  const panel = page.getByTestId('history-panel');
  await expect(panel.locator('[data-testid^="version-"]')).toHaveCount(3);
  await expect(page.getByTestId('version-2')).toHaveAttribute('data-head', 'true');
  await expect(page.getByTestId('changes-2')).toContainText('NEWNAME.TXT');
  await expect(page.getByTestId('changes-1')).toContainText('HELLO.TXT');

  // Restore version 1 from the panel: HELLO.TXT is back under its first name.
  await page.getByTestId('restore-1').click();
  await expect(page.getByTestId('restore-dialog')).toBeVisible();
  await page.getByTestId('restore-confirm').click();
  await expect(page.getByTestId('restore-dialog')).toHaveCount(0, AFTER_EDIT);
  await expect(page.locator('[data-testid="fs-entry"][data-name="HELLO.TXT"]')).toBeVisible(AFTER_EDIT);
  const back = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body()));
  if (!back.ok) throw new Error(`expected a volume, got ${back.reason}`);
  expect(back.root.map((e) => e.name)).toEqual(['HELLO.TXT']);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `PORT=3100 pnpm exec playwright test e2e/create-adf.spec.ts e2e/hd-disks.spec.ts --reporter=line`
Expected: both new tests FAIL — there is no `create-adf-hd-ffs` item.

- [ ] **Step 4: The route**

In `src/app/api/disks/create/route.ts` add to the `body` schema after `filesystem`:

```ts
  /** 'dd' (880 KB) unless asked for 'hd' (1.76 MB) -- HD writes spec §6.3. */
  density: z.enum(['dd', 'hd']).optional(),
```

replace `const bytes = formatVolume({ filesystem, volumeName });` with:

```ts
  // DD by default: the drive and most software expect it, and HD needs
  // Kickstart 3.0+ and firmware 1.4.1+ to play at all.
  const density = parsed.data.density ?? 'dd';
  const bytes = formatVolume({ filesystem, volumeName, density });
```

change the comment `these 880 KB are already in this` to `these 880 KB (or 1.76 MB) are already in this`, and the final return to `return Response.json({ gameId, diskId, sha256, volumeName, filesystem, density, collectionId });`.

- [ ] **Step 5: The menu**

In `src/components/library/create-adf.tsx` replace `create`'s signature, its fetch body and its toast with:

```tsx
  async function create(filesystem: 'FFS' | 'OFS', density: 'dd' | 'hd') {
    setBusy(true);
    try {
      const collectionId = params.get('collection');
      const res = await fetch('/api/disks/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filesystem, density, ...(collectionId ? { collectionId } : {}) }),
      });
      if (!res.ok) {
        toast.error('Could not create the disk');
        return;
      }
      const body = await res.json().catch(() => null);
      toast.success(`Blank ${density === 'hd' ? 'HD ' : ''}${filesystem} disk created`, {
        description: body?.collectionId ? 'Added to this collection.' : 'Name it on its card.',
      });
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }
```

and replace the two `DropdownMenuItem`s (keeping the comment above them) with:

```tsx
        <DropdownMenuItem data-testid="create-adf-ffs" onClick={() => create('FFS', 'dd')}>
          Create ADF (FFS)
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="create-adf-ofs" onClick={() => create('OFS', 'dd')}>
          Create ADF (OFS)
        </DropdownMenuItem>
        {/* HD after DD, never first: DD is the default (HD writes spec §6.3),
            and the first item on a menu IS the default. Named in the item for
            the same reason the filesystem is -- a choice made per click, never
            carried to the next disk. */}
        <DropdownMenuItem data-testid="create-adf-hd-ffs" onClick={() => create('FFS', 'hd')}>
          Create HD ADF (FFS)
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="create-adf-hd-ofs" onClick={() => create('OFS', 'hd')}>
          Create HD ADF (OFS)
        </DropdownMenuItem>
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec tsc --noEmit -p . && pnpm lint
PORT=3100 pnpm exec playwright test e2e/create-adf.spec.ts e2e/hd-disks.spec.ts e2e/time-machine.spec.ts --reporter=line
```

Expected: all pass. Stop your dev server by its PID only.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/disks/create/route.ts src/components/library/create-adf.tsx e2e/helpers.ts \
  e2e/create-adf.spec.ts e2e/hd-disks.spec.ts
git commit -F- <<'EOF'
create disk: blank HD disks (DD stays the default); e2e edits and restores one

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 8: Firmware — decode the mounted disk's sector count, and judge it

**Files:**
- Modify: `wifi-floppy/firmware/src/mfm.h:18-49,51-87`, `wifi-floppy/firmware/src/mfm.c:66-166`, `wifi-floppy/firmware/src/write_back.h:16-38`, `wifi-floppy/firmware/src/write_back.c:1-37`, `wifi-floppy/firmware/src/main.c:2455-2502` (the capture decode)
- Test: `wifi-floppy/firmware/test/test_mfm.c`, `wifi-floppy/firmware/test/test_write_back.c`

**Interfaces:**
- Consumes: the committed Greaseweazle fixtures `test/fixtures/adf_mfm_hd/prng-t{000,001,080,159}.mfm` (25,336 bytes each; the xorshift32 'prng' HD disk, seed `0x12345678` over all 1,802,240 bytes).
- Produces:
  - `mfm.h`: `MFM_HD_SECTORS 22`, `MFM_MAX_SECTORS 22`, `MFM_HD_TRACK_DATA_BYTES 11264`; `mfm_decode_result_t.found` is `uint32_t`, new field `uint16_t foreign_sectors`; `void mfm_decode_track_n(const uint8_t *mfm, size_t len, uint8_t *adf_out, mfm_decode_result_t *out, unsigned nsec)` (core0); `void mfm_decode_track_rn(const uint8_t *mfm, size_t len, uint8_t *adf_out, mfm_decode_result_t *out, uint8_t *scratch, unsigned nsec)`. `mfm_decode_track` and `mfm_decode_track_r` keep their signatures and decode 11 sectors.
  - `write_back.h`: `WB_REJECT_DENSITY` (replaces `WB_REJECT_READ_ONLY` as the last enumerator); `unsigned write_back_sectors(int32_t token)`; `uint32_t write_back_mask(unsigned nsec)`; `const char *write_back_reason(wb_verdict_t v, unsigned nsec)`.

- [ ] **Step 1: Write the failing tests**

In `wifi-floppy/firmware/test/test_mfm.c` add before `int main(void)`:

```c
/* ---- HD (HD writes spec §4.2): Greaseweazle's AmigaDOS_HD fixtures ------ */

#define HD_MFM_BYTES 25336

/* scripts/adf-mfm-hd-fixtures.py's 'prng' disk: xorshift32 from 0x12345678
 * over all 1,802,240 bytes. Track `t` is bytes t*11264 .. (t+1)*11264. */
static void hd_prng_track(unsigned t, uint8_t *out) {
    uint32_t x = 0x12345678u;
    const size_t from = (size_t)t * MFM_HD_TRACK_DATA_BYTES;
    for (size_t i = 0; i < from + MFM_HD_TRACK_DATA_BYTES; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        if (i >= from) out[i - from] = (uint8_t)x;
    }
}

static int read_hd_fixture(int track_no, uint8_t *out) {
    char path[128];
    snprintf(path, sizeof path, "fixtures/adf_mfm_hd/prng-t%03d.mfm", track_no);
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t n = fread(out, 1, HD_MFM_BYTES, f);
    fclose(f);
    return n == HD_MFM_BYTES;
}

static void test_an_hd_track_decodes_all_22_sectors(void) {
    static uint8_t mfm[HD_MFM_BYTES], got[MFM_HD_TRACK_DATA_BYTES], want[MFM_HD_TRACK_DATA_BYTES];
    static const int tracks[] = { 0, 1, 80, 159 };
    for (unsigned i = 0; i < 4; i++) {
        const int t = tracks[i];
        CHECK(read_hd_fixture(t, mfm), "fixtures/adf_mfm_hd (scripts/adf-mfm-hd-fixtures.py)");
        hd_prng_track((unsigned)t, want);
        memset(got, 0, sizeof got);
        mfm_decode_result_t r;
        mfm_decode_track_n(mfm, sizeof mfm, got, &r, MFM_HD_SECTORS);
        CHECK_EQ_INT(r.found, 0x3fffff);
        CHECK_EQ_INT(r.track_no, t);
        CHECK_EQ_INT(r.bad_checksums, 0);
        CHECK_EQ_INT(r.foreign_sectors, 0);
        CHECK(memcmp(got, want, sizeof want) == 0, "the ADF bytes Greaseweazle encoded");
    }
}

static void test_a_dd_read_of_an_hd_track_counts_its_foreign_sectors(void) {
    static uint8_t mfm[HD_MFM_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    CHECK(read_hd_fixture(80, mfm), "fixture");
    mfm_decode_result_t r;
    mfm_decode_track_n(mfm, sizeof mfm, got, &r, MFM_SECTORS);
    CHECK_EQ_INT(r.found, 0x7ff);            /* complete by the DD mask alone... */
    CHECK_EQ_INT(r.foreign_sectors, 11);     /* ...which is why ids 11..21 are counted */
}

static void test_an_hd_read_of_a_dd_track_is_partial(void) {
    static uint8_t data[MFM_TRACK_DATA_BYTES], mfm[MFM_TRACK_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    for (size_t i = 0; i < sizeof data; i++) data[i] = (uint8_t)(i * 13u);
    mfm_encode_track(data, 80, mfm);
    mfm_decode_result_t r;
    mfm_decode_track_n(mfm, sizeof mfm, got, &r, MFM_HD_SECTORS);
    CHECK_EQ_INT(r.found, 0x7ff);            /* 11 of 22 */
    CHECK_EQ_INT(r.foreign_sectors, 0);
}

static void test_an_impossible_sector_count_finds_nothing(void) {
    static uint8_t mfm[HD_MFM_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    CHECK(read_hd_fixture(80, mfm), "fixture");
    mfm_decode_result_t r;
    mfm_decode_track_n(mfm, sizeof mfm, got, &r, 0);
    CHECK_EQ_INT(r.found, 0);
    mfm_decode_track_n(mfm, sizeof mfm, got, &r, MFM_MAX_SECTORS + 1);
    CHECK_EQ_INT(r.found, 0);
}
```

and register them at the end of `main` (before `return REPORT();`):

```c
    RUN(test_an_hd_track_decodes_all_22_sectors);
    RUN(test_a_dd_read_of_an_hd_track_counts_its_foreign_sectors);
    RUN(test_an_hd_read_of_a_dd_track_is_partial);
    RUN(test_an_impossible_sector_count_finds_nothing);
```

In `wifi-floppy/firmware/test/test_write_back.c`:
- Replace `every_verdict_has_a_reason` with:

```c
static void every_verdict_has_a_reason(void) {
    for (int v = WB_APPLY; v <= WB_REJECT_DENSITY; v++) {
        CHECK(write_back_reason((wb_verdict_t)v, MFM_SECTORS)[0] != '\0', "a log line needs a reason");
        CHECK(write_back_reason((wb_verdict_t)v, MFM_HD_SECTORS)[0] != '\0', "on HD too");
    }
    CHECK(strstr(write_back_reason(WB_REJECT_PARTIAL, MFM_SECTORS), "11") != NULL, "DD names its count");
    CHECK(strstr(write_back_reason(WB_REJECT_PARTIAL, MFM_HD_SECTORS), "22") != NULL, "HD names its count");
}
```

- Replace `an_hd_disk_takes_no_writes` with:

```c
// HD writes spec §4.2: the mounted disk's count decides. An HD disk wants all
// 22 sectors; a DD disk refuses any good sector numbered past 10.
static void an_hd_disk_wants_all_22_sectors(void) {
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    int32_t tok = mounted_token();
    CHECK_EQ_INT(write_back_sectors(tok), MFM_HD_SECTORS);
    CHECK_EQ_INT(write_back_mask(MFM_HD_SECTORS), 0x3fffff);
    mfm_decode_result_t d = whole(80);            /* 0x7ff: 11 of 22 */
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    d.found = 0x3fffffu;
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_APPLY);
    psram_image_reset_slot(0);     /* back to MFM, for anything that runs after */
}

static void a_dd_disk_refuses_sectors_past_10(void) {
    psram_image_reset_slot(0);
    int32_t tok = mounted_token();
    CHECK_EQ_INT(write_back_sectors(tok), MFM_SECTORS);
    mfm_decode_result_t d = whole(80);
    d.foreign_sectors = 11;                        /* ids 11..21 of an HD track */
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_DENSITY);
    CHECK_EQ_INT(write_back_verdict(&d, 80, true, tok, tok), WB_REJECT_OVERFLOW);   /* order: overflow first */
}

#define HD_MFM_BYTES 25336u

static bool read_hd_fixture80(uint8_t *out) {
    FILE *f = fopen("fixtures/adf_mfm_hd/prng-t080.mfm", "rb");
    if (!f) return false;
    const size_t n = fread(out, 1, HD_MFM_BYTES, f);
    fclose(f);
    return n == HD_MFM_BYTES;
}

// Real tracks, not hand-set bitmaps: Greaseweazle's HD track on a DD disk,
// and our DD encoder's track on an HD disk (spec §7, firmware host).
static void a_dd_disk_refuses_a_real_hd_track(void) {
    static uint8_t mfm[HD_MFM_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    CHECK(read_hd_fixture80(mfm), "fixtures/adf_mfm_hd/prng-t080.mfm");
    psram_image_reset_slot(0);                     /* MFM: a DD disk */
    int32_t tok = mounted_token();
    mfm_decode_result_t d;
    mfm_decode_track_n(mfm, HD_MFM_BYTES, got, &d, write_back_sectors(tok));
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_DENSITY);
}

static void an_hd_disk_refuses_a_real_dd_track(void) {
    static uint8_t data[MFM_TRACK_DATA_BYTES], mfm[MFM_TRACK_BYTES], got[MFM_HD_TRACK_DATA_BYTES];
    memset(data, 0x42, sizeof data);
    mfm_encode_track(data, 80, mfm);
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    int32_t tok = mounted_token();
    mfm_decode_result_t d;
    mfm_decode_track_n(mfm, sizeof mfm, got, &d, write_back_sectors(tok));
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    psram_image_reset_slot(0);
}
```

- In `main`, replace `RUN(an_hd_disk_takes_no_writes);` with:

```c
    RUN(an_hd_disk_wants_all_22_sectors);
    RUN(a_dd_disk_refuses_sectors_past_10);
    RUN(a_dd_disk_refuses_a_real_hd_track);
    RUN(an_hd_disk_refuses_a_real_dd_track);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "COMPILE FAIL|FAIL|checks" | head -20`
Expected: `COMPILE FAIL: test_mfm.c` and `COMPILE FAIL: test_write_back.c` (`mfm_decode_track_n`, `MFM_HD_SECTORS`, `foreign_sectors`, `WB_REJECT_DENSITY`, `write_back_sectors` undeclared).

- [ ] **Step 3: mfm.h**

In `wifi-floppy/firmware/src/mfm.h` replace lines 18-20 with:

```c
#define MFM_SECTORS            11
/* HD writes spec §4.2: an HD track has 22. Which count a decode uses is the
 * MOUNTED DISK's (write_back_sectors()), never inferred from the data. */
#define MFM_HD_SECTORS         22
#define MFM_MAX_SECTORS        MFM_HD_SECTORS
#define MFM_SECTOR_DATA_BYTES  512
#define MFM_TRACK_DATA_BYTES   (MFM_SECTORS * MFM_SECTOR_DATA_BYTES)      /* 5632 */
#define MFM_HD_TRACK_DATA_BYTES (MFM_HD_SECTORS * MFM_SECTOR_DATA_BYTES)  /* 11264 */
```

In `mfm_decode_result_t` replace the `found` and `bad_checksums` fields (with their comments) with:

```c
    /** Bitmap of sectors recovered, bit n = sector n. All `nsec` bits (0x7ff
     *  DD, 0x3fffff HD) means a complete track; anything less names exactly
     *  which are missing, which is the difference between "retry" and "this
     *  disk is damaged". */
    uint32_t found;
    /** Sectors whose header or data checksum failed. Counted rather than
     *  fatal: a capture spanning more than one revolution sees every sector
     *  more than once, and one bad copy alongside a good one is a recoverable
     *  read, not a failed track. */
    uint16_t bad_checksums;
    /** Checksum-good sectors whose id is `nsec` or more: sectors of a track of
     *  the other density. An HD track read with nsec 11 has 11 of these, and
     *  sectors 0..10 alone would look complete. Never stored; the verdict
     *  refuses the track (WB_REJECT_DENSITY). */
    uint16_t foreign_sectors;
```

Replace the declarations of `mfm_decode_track` (with its doc comment's last sentence kept) and `mfm_decode_track_r` with:

```c
void mfm_decode_track(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                      mfm_decode_result_t *out);

/**
 * mfm_decode_track for `nsec` sectors: 11 (DD) or 22 (HD), the MOUNTED disk's
 * count (HD writes spec §4.2). `adf_out` holds nsec * 512 bytes. An `nsec` of
 * 0 or more than MFM_MAX_SECTORS finds nothing. core0's, like
 * mfm_decode_track, which is this with nsec 11.
 */
void mfm_decode_track_n(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                        mfm_decode_result_t *out, unsigned nsec);
```

keep `MFM_DECODE_SCRATCH_BYTES` and the WHO CALLS WHICH comment, and replace the `mfm_decode_track_r` declaration under it with:

```c
void mfm_decode_track_r(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                        mfm_decode_result_t *out, uint8_t *scratch);   /* 11 sectors */
void mfm_decode_track_rn(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                         mfm_decode_result_t *out, uint8_t *scratch, unsigned nsec);
```

- [ ] **Step 4: mfm.c**

In `wifi-floppy/firmware/src/mfm.c`:
- Rename the definition `void mfm_decode_track_r(const uint8_t *mfm, size_t len, uint8_t *adf_out, mfm_decode_result_t *out, uint8_t *scratch) {` to `void mfm_decode_track_rn(const uint8_t *mfm, size_t len, uint8_t *adf_out, mfm_decode_result_t *out, uint8_t *scratch, unsigned nsec) {`.
- After `out->track_no_consistent = true;` add:

```c
    // HD writes spec §4.2: a count this decoder cannot represent finds
    // nothing, rather than shifting past `found`'s 32 bits.
    if (nsec == 0 || nsec > MFM_MAX_SECTORS) return;
```

- Replace the rejection block

```c
        uint8_t sector_id = header[2];
        if (!ok || sector_id >= MFM_SECTORS) {
```

(and its body, up to and including its `continue; }`) with:

```c
        uint8_t sector_id = header[2];
        if (!ok) {
            // Advance by ONE BIT, not by a sector: a false sync inside data
            // would otherwise skip 1088 bytes and step over the real sector
            // that follows it. Only a sector that verifies earns the long stride.
            out->bad_checksums++;
            continue;
        }
        if (sector_id >= nsec) {
            // A good sector the mounted disk has no room for: the Amiga wrote
            // a track of the other density (an HD track on a DD disk has ids
            // 11..21). Counted, never stored -- the verdict refuses the whole
            // track (write_back.c, WB_REJECT_DENSITY).
            out->foreign_sectors++;
            continue;
        }
```

- Replace `out->found |= (uint16_t)(1u << sector_id);` with `out->found |= 1u << sector_id;`.
- Replace the `mfm_decode_track` definition (and its comment) with:

```c
// The DD decoder through caller scratch: core1's uploader (uploader.c).
void mfm_decode_track_r(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                        mfm_decode_result_t *out, uint8_t *scratch) {
    mfm_decode_track_rn(mfm, len, adf_out, out, scratch, MFM_SECTORS);
}

// core0's decoder: the capture decode and the verify re-decode, both on
// core0's service loop, one at a time -- never core1, which calls
// mfm_decode_track_r with scratch of its own (uploader.c). This static is
// core0's alone for exactly that reason; see mfm.h.
void mfm_decode_track_n(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                        mfm_decode_result_t *out, unsigned nsec) {
    static uint8_t core0_scratch[MFM_DECODE_SCRATCH_BYTES];
    mfm_decode_track_rn(mfm, len, adf_out, out, core0_scratch, nsec);
}

void mfm_decode_track(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                      mfm_decode_result_t *out) {
    mfm_decode_track_n(mfm, len, adf_out, out, MFM_SECTORS);
}
```

- [ ] **Step 5: write_back.h and write_back.c**

In `wifi-floppy/firmware/src/write_back.h` replace the enum's last two lines (`WB_REJECT_WRONG_TRACK,` … `WB_REJECT_READ_ONLY, …`) with:

```c
    WB_REJECT_WRONG_TRACK,      // a valid track, for a cylinder the head is not on
    WB_REJECT_DENSITY,          // good sectors numbered past the disk's count: the other density's track
} wb_verdict_t;
```

and replace the `write_back_reason` declaration with:

```c
// The mounted disk's sectors a track: 22 for an ADF_HD slot, 11 otherwise
// (HD writes spec §4.2). What main.c decodes a capture with, and what the
// verdict counts against -- both from the same token, so they cannot differ.
unsigned write_back_sectors(int32_t token);

// All `nsec` sectors found: 0x7ff DD, 0x3fffff HD.
uint32_t write_back_mask(unsigned nsec);

// Short, log-line sized. `nsec` names the count (spec §4.2).
const char *write_back_reason(wb_verdict_t v, unsigned nsec);
```

In `wifi-floppy/firmware/src/write_back.c` replace everything from the top down to (not including) `bool write_back_apply(` with:

```c
#include "write_back.h"
#include "psram_image.h"
#include <stdbool.h>

unsigned write_back_sectors(int32_t token) {
    return psram_image_slot_kind(psram_token_slot(token)) == SLOT_KIND_ADF_HD
        ? MFM_HD_SECTORS : MFM_SECTORS;
}

uint32_t write_back_mask(unsigned nsec) {
    return nsec >= 32u ? 0xffffffffu : (1u << nsec) - 1u;
}

wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now) {
    // Disk identity first: a write belongs to the disk that was mounted when
    // WGATE asserted, and to no other -- however good its sectors are.
    if (psram_token_slot(token_now) == SLOT_NONE) return WB_REJECT_NO_DISK;
    if (token_now != token_at_wgate)              return WB_REJECT_DISK_CHANGED;
    if (overflowed)                               return WB_REJECT_OVERFLOW;
    // HD writes spec §4.2: the mounted disk's count decides, never the data's.
    // A DD disk given an HD track decodes sectors 0..10 cleanly -- complete by
    // the mask alone -- so its good sectors 11..21 are what give it away.
    if (d->foreign_sectors)                       return WB_REJECT_DENSITY;
    if (d->found != write_back_mask(write_back_sectors(token_now)))
                                                  return WB_REJECT_PARTIAL;
    if (!d->track_no_consistent)                  return WB_REJECT_INCONSISTENT;
    // The one corruption a checksum cannot see: a valid track for a cylinder
    // the head is not on.
    if ((int)d->track_no != head_track)           return WB_REJECT_WRONG_TRACK;
    return WB_APPLY;
}

const char *write_back_reason(wb_verdict_t v, unsigned nsec) {
    const bool hd = nsec == MFM_HD_SECTORS;
    switch (v) {
    case WB_APPLY:               return "applied";
    case WB_REJECT_NO_DISK:      return "no disk mounted";
    case WB_REJECT_DISK_CHANGED: return "disk changed during the write";
    case WB_REJECT_OVERFLOW:     return "capture overflowed";
    case WB_REJECT_PARTIAL:      return hd ? "not all 22 sectors verified" : "not all 11 sectors verified";
    case WB_REJECT_INCONSISTENT: return "sector headers disagree about the track";
    case WB_REJECT_WRONG_TRACK:  return "sectors name another track";
    case WB_REJECT_DENSITY:      return hd ? "sectors numbered past 22"
                                           : "sectors numbered past 11: an HD track on a DD disk";
    }
    return "unknown";
}
```

- [ ] **Step 6: main.c decodes with the mounted disk's count**

In `wifi-floppy/firmware/src/main.c`, in the capture block, replace from `static uint8_t decoded[MFM_TRACK_DATA_BYTES];` through the first `wf_logf(WF_INFO, "write: trk %d %u iv …` call (inclusive) with:

```c
                // HD writes spec §4.2: the mounted disk's sector count -- the
                // disk WGATE wrote to (wtok), never what the data looks like.
                const unsigned nsec = write_back_sectors(wtok);
                const uint32_t want = write_back_mask(nsec);
                static uint8_t decoded[MFM_HD_TRACK_DATA_BYTES];
                mfm_decode_result_t d;
                memset(decoded, 0, sizeof decoded);
                mfm_decode_track_n(cap.mfm, cap.mfm_bytes, decoded, &d, nsec);
                wf_logf(WF_INFO,
                        "write: trk %d %u iv %u B sec 0x%06lx/%u%s bad %u foreign %u rng %u%s",
                        wt,
                        (unsigned)cap.intervals, (unsigned)cap.mfm_bytes,
                        (unsigned long)d.found, nsec,
                        d.found == want ? " ALL" : " PART",
                        (unsigned)d.bad_checksums, (unsigned)d.foreign_sectors,
                        (unsigned)cap.out_of_range,
                        cap.overflowed ? " OVERFLOWED" : "");
```

and change `wt, write_back_reason(v));` to `wt, write_back_reason(v, nsec));`. The verify sweep (`#if WF_VERIFY_TRACKS`) is unchanged: it decodes DD only, through `mfm_decode_track`, and an HD slot skips it.

- [ ] **Step 7: Run the host tests and the device build**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -5; echo "exit=$?"
pnpm firmware:build 2>&1 | tail -3
```

Expected: every test binary reports 0 failed and `exit=0`; the device build links with no warnings about `mfm_decode_track_n` or format strings.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/mfm.h wifi-floppy/firmware/src/mfm.c wifi-floppy/firmware/src/write_back.h \
  wifi-floppy/firmware/src/write_back.c wifi-floppy/firmware/src/main.c \
  wifi-floppy/firmware/test/test_mfm.c wifi-floppy/firmware/test/test_write_back.c
git commit -F- <<'EOF'
firmware: decode 11 or 22 sectors by the mounted disk; verdict refuses the other density

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 9: Firmware — the capture holds one HD write

**Files:**
- Modify: `wifi-floppy/firmware/src/flux_bits.h` (after the includes), `wifi-floppy/firmware/src/flux_capture.h:10-12,28-43`, `wifi-floppy/firmware/src/flux_capture.c:29-30`
- Test: `wifi-floppy/firmware/test/test_flux_bits.c`

**Interfaces:**
- Consumes: Task 8's `mfm_decode_track_n`, `MFM_HD_SECTORS`, `MFM_HD_TRACK_DATA_BYTES`.
- Produces: `FLUX_CAPTURE_MAX_MS` (800) and `FLUX_CAPTURE_BUF_BYTES` (32,768) in `flux_bits.h` — host-visible; `flux_capture.h` includes `flux_bits.h` and no longer defines `FLUX_CAPTURE_MAX_MS` itself (`main.c` includes both, so its timeout log is unchanged).

- [ ] **Step 1: Write the failing tests**

In `wifi-floppy/firmware/test/test_flux_bits.c` add before `int main(void)`:

```c
/* ---- HD writes spec §4.1: one HD write fits the capture ------------------ */

#define HD_MFM_BYTES      25336u
/* A DD write carries ~13,264 bits (1,658 bytes) of gap before its sectors
 * (HANDOFF: "a write is gap first ... ending at bit 108,980 of a 108,992-bit
 * capture"). The HD gap is not measured yet (bench step 3 logs it), so this
 * assumes it scales with the track: twice DD's. */
#define HD_LEAD_GAP_BYTES 3316u

static void hd_prng_track(unsigned t, uint8_t *out) {
    uint32_t x = 0x12345678u;
    const size_t from = (size_t)t * MFM_HD_TRACK_DATA_BYTES;
    for (size_t i = 0; i < from + MFM_HD_TRACK_DATA_BYTES; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        if (i >= from) out[i - from] = (uint8_t)x;
    }
}

static void test_an_hd_write_fits_the_capture_buffer(void) {
    // Greaseweazle's HD track 80 behind a doubled DD lead gap: MFM-coded zero
    // bytes, 0xAA on the wire, a transition every two cells.
    static uint8_t wire[HD_LEAD_GAP_BYTES + HD_MFM_BYTES];
    memset(wire, 0xaa, HD_LEAD_GAP_BYTES);
    FILE *f = fopen("fixtures/adf_mfm_hd/prng-t080.mfm", "rb");
    CHECK(f != NULL, "fixtures/adf_mfm_hd/prng-t080.mfm (scripts/adf-mfm-hd-fixtures.py)");
    if (!f) return;
    const size_t n = fread(wire + HD_LEAD_GAP_BYTES, 1, HD_MFM_BYTES, f);
    fclose(f);
    CHECK_EQ_INT(n, HD_MFM_BYTES);

    static uint8_t buf[FLUX_CAPTURE_BUF_BYTES];
    flux_bits_t fb;
    flux_bits_init(&fb, buf, sizeof buf);
    size_t prev = SIZE_MAX;
    for (size_t i = 0; i < sizeof wire * 8u; i++) {
        if (!bit_at(wire, i)) continue;
        if (prev != SIZE_MAX) flux_bits_feed(&fb, (uint32_t)(i - prev) * CELL_NS);
        prev = i;
    }
    CHECK(!fb.overflowed, "a whole HD write, lead gap included, fits the buffer");

    static uint8_t got[MFM_HD_TRACK_DATA_BYTES], want[MFM_HD_TRACK_DATA_BYTES];
    hd_prng_track(80, want);
    mfm_decode_result_t r;
    mfm_decode_track_n(buf, flux_bits_bytes(&fb), got, &r, MFM_HD_SECTORS);
    CHECK_EQ_INT(r.found, 0x3fffff);
    CHECK(memcmp(got, want, sizeof want) == 0, "every sector comes back from the capture");
}

static void test_a_wgate_held_for_the_whole_window_overflows(void) {
    // 800 ms of the densest legal flux (4 us gaps) is 400,000 cells: more than
    // any buffer here. It must say so -- the verdict then rejects it
    // (WB_REJECT_OVERFLOW) -- never wrap or drop silently.
    static uint8_t buf[FLUX_CAPTURE_BUF_BYTES];
    flux_bits_t fb;
    flux_bits_init(&fb, buf, sizeof buf);
    for (uint32_t i = 0; i < FLUX_CAPTURE_MAX_MS * 1000u / 4u; i++) flux_bits_feed(&fb, 4000u);
    CHECK(fb.overflowed, "flagged");
    CHECK_EQ_INT(flux_bits_bytes(&fb), FLUX_CAPTURE_BUF_BYTES);
}
```

and register them in `main`:

```c
    RUN(test_an_hd_write_fits_the_capture_buffer);
    RUN(test_a_wgate_held_for_the_whole_window_overflows);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "COMPILE FAIL|FAIL" | head`
Expected: `COMPILE FAIL: test_flux_bits.c` (`FLUX_CAPTURE_BUF_BYTES`, `FLUX_CAPTURE_MAX_MS` undeclared).

- [ ] **Step 3: Move the two sizes into flux_bits.h and grow them**

In `wifi-floppy/firmware/src/flux_bits.h`, after `#include <stdbool.h>`, add:

```c
/**
 * The capture's window and buffer (HD writes spec §4.1). Here rather than in
 * flux_capture.h so the host tests can hold the accumulator to them:
 * flux_capture.h is device-only (it includes hardware/pio.h).
 *
 * 800 ms: two HD revolutions (an Amiga HD drive spins at 150 rpm, 400 ms a
 * turn, with the same 2 us cell as DD). A write is one revolution plus its
 * lead gap; a WGATE held longer than this is not a write.
 *
 * 32,768 bytes: one HD write, lead gap included, with DD's margin. A DD write
 * measured 108,992 bits (13,624 bytes) against DD's 16,384-byte buffer; an HD
 * write at twice that is ~27,250. The spec's 28,672 would leave 5 %; this
 * leaves DD's 20 % for 4 KB more. Bench step 3 records the real size (the
 * `write: trk N ... B` log line).
 */
#define FLUX_CAPTURE_MAX_MS     800u
#define FLUX_CAPTURE_BUF_BYTES  32768u
```

In `wifi-floppy/firmware/src/flux_capture.h` add `#include "flux_bits.h"` after `#include "hardware/pio.h"`; in `flux_capture_timeout`'s comment change `One track write is a single revolution -- ~200 ms.` to `One track write is a single revolution -- 200 ms DD, 400 ms HD.`; and replace

```c
/** How long a capture may run before flux_capture_timeout() abandons it.
 *  Generously more than the ~200 ms one revolution takes. */
#define FLUX_CAPTURE_MAX_MS 400u
```

with

```c
/* How long a capture may run before flux_capture_timeout() abandons it:
 * FLUX_CAPTURE_MAX_MS, in flux_bits.h (host-visible). */
```

In `wifi-floppy/firmware/src/flux_capture.c` replace lines 29-30 with:

```c
/* One HD write, lead gap included (flux_bits.h says how it is sized). */
#define MFM_BUF_BYTES   FLUX_CAPTURE_BUF_BYTES
```

- [ ] **Step 4: Run the host tests and the device build**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -5; echo "exit=$?"
pnpm firmware:build 2>&1 | tail -3
```

Expected: `exit=0`; the device build succeeds (`main.c`'s `write: WGATE asserted for over %u ms` now prints 800).

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/flux_bits.h wifi-floppy/firmware/src/flux_capture.h \
  wifi-floppy/firmware/src/flux_capture.c wifi-floppy/firmware/test/test_flux_bits.c
git commit -F- <<'EOF'
firmware: capture window 800 ms and buffer 32 KB -- one HD write, lead gap included

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 10: Firmware — a verified HD track is stored as ADF bytes

**Files:**
- Modify: `wifi-floppy/firmware/src/psram_image.h:94-96`, `wifi-floppy/firmware/src/psram_image.c` (includes, `store()`'s ADF_HD comment, new function after `psram_image_mark_dirty`), `wifi-floppy/firmware/src/write_back.h:36-38`, `wifi-floppy/firmware/src/write_back.c` (`write_back_apply`)
- Test: `wifi-floppy/firmware/test/test_write_back.c`

**Interfaces:**
- Consumes: Task 8's decoder and verdict, Task 9's `FLUX_CAPTURE_BUF_BYTES`; the existing `track_cache_get` HD encode and `track_cache_invalidate`.
- Produces: `bool psram_image_store_adf(int slot, int track, const uint8_t *adf)` — stores `MFM_HD_TRACK_DATA_BYTES` as DIRTY in an `ADF_HD` slot, false otherwise. `write_back_apply(slot, track, adf_track)` stores HD tracks through it (DD unchanged).

- [ ] **Step 1: Write the failing tests**

In `wifi-floppy/firmware/test/test_write_back.c` add `#include "../src/adf_mfm.h"` after the `track_cache.h` include, and add before `int main(void)`:

```c
static void the_hd_store_takes_only_an_hd_slot(void) {
    static uint8_t adf[MFM_HD_TRACK_DATA_BYTES];
    memset(adf, 0x5a, sizeof adf);
    psram_image_reset_slot(0);                               /* MFM */
    CHECK(!psram_image_store_adf(0, 3, adf), "an MFM slot never takes ADF bytes");
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    CHECK(!psram_image_store_adf(0, NUM_TRACKS, adf), "a track past the disk");
    CHECK(psram_image_store_adf(0, 3, adf), "an HD slot does");
    CHECK_EQ_INT(psram_image_state(0, 3), TRK_DIRTY);
    CHECK_EQ_INT(psram_image_bits(0, 3), MFM_HD_TRACK_DATA_BYTES * 8u);
    CHECK(memcmp(psram_image_track_data(0, 3), adf, sizeof adf) == 0, "the bytes as given");
    static uint8_t mfm[MFM_TRACK_BYTES];
    psram_image_mark_dirty(0, 4, mfm, MFM_TRACK_BITS);
    CHECK_EQ_INT(psram_image_state(0, 4), TRK_ABSENT);       /* MFM never goes into an ADF slot */
    psram_image_reset_slot(0);
}

// HD writes spec §7, firmware host: Greaseweazle's encoding of an HD track
// (independent of this code), through the board's whole chain -- flux ->
// bits -> 22 sectors -> verdict -> store -> encode on read -- must give back
// the ADF bytes, and the served track must be Greaseweazle's, byte for byte.
static void an_hd_write_is_stored_and_served_back(void) {
    static uint8_t wire[HD_MFM_BYTES], want[MFM_HD_TRACK_DATA_BYTES], zeros[MFM_HD_TRACK_DATA_BYTES];
    CHECK(read_hd_fixture80(wire), "fixtures/adf_mfm_hd/prng-t080.mfm");
    uint32_t x = 0x12345678u;                                /* the 'prng' disk's track 80 */
    for (size_t i = 0; i < 81u * MFM_HD_TRACK_DATA_BYTES; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        if (i >= 80u * MFM_HD_TRACK_DATA_BYTES) want[i - 80u * MFM_HD_TRACK_DATA_BYTES] = (uint8_t)x;
    }

    // An HD disk in slot 0 whose track 80 holds zeros, served (and so cached)
    // before the write.
    memset(zeros, 0, sizeof zeros);
    psram_image_reset_slot(0);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    psram_image_write_at(0, 80, 0, zeros, (int)sizeof zeros);
    psram_image_commit(0, 80, MFM_HD_TRACK_DATA_BYTES * 8u);
    psram_publish_slot(0);
    const int32_t tok = psram_active_token();
    uint32_t bits = 0;
    CHECK(track_cache_get(80, &bits) != NULL, "the old track is served");

    static uint8_t capbuf[FLUX_CAPTURE_BUF_BYTES];
    for (unsigned skew = 1; skew <= 7; skew += 3) {
        flux_bits_t fb;
        flux_bits_init(&fb, capbuf, sizeof capbuf);
        size_t prev = SIZE_MAX;
        for (size_t i = skew; i < HD_MFM_BYTES * 8u; i++) {
            if (!bit_at(wire, i)) continue;
            if (prev != SIZE_MAX) flux_bits_feed(&fb, (uint32_t)(i - prev) * CELL_NS);
            prev = i;
        }
        static uint8_t decoded[MFM_HD_TRACK_DATA_BYTES];
        memset(decoded, 0, sizeof decoded);
        mfm_decode_result_t d;
        mfm_decode_track_n(capbuf, flux_bits_bytes(&fb), decoded, &d, write_back_sectors(tok));
        CHECK_EQ_INT(d.found, 0x3fffff);
        CHECK_EQ_INT(write_back_verdict(&d, 80, fb.overflowed, tok, psram_active_token()), WB_APPLY);
        CHECK(write_back_apply(0, 80, decoded), "an HD track is stored");
        CHECK_EQ_INT(psram_image_state(0, 80), TRK_DIRTY);
        const uint8_t *stored = psram_image_track_data(0, 80);
        CHECK(stored != NULL && memcmp(stored, want, sizeof want) == 0,
              "PSRAM holds the ADF bytes the Amiga wrote");

        track_cache_invalidate(80);                          /* main.c does this after every apply */
        const uint8_t *served = track_cache_get(80, &bits);
        CHECK(served != NULL, "served");
        CHECK_EQ_INT(bits, ADF_MFM_HD_TRACK_BITS);
        CHECK(served != NULL && memcmp(served, wire, HD_MFM_BYTES) == 0,
              "re-encoded exactly as Greaseweazle encoded it");

        // Back to the old contents for the next skew.
        psram_image_write_at(0, 80, 0, zeros, (int)sizeof zeros);
        psram_image_clear_dirty(0, 80);
        track_cache_invalidate(80);
    }
    psram_image_reset_slot(0);
}
```

(`read_hd_fixture80` and `HD_MFM_BYTES` are Task 8's, earlier in this file; `bit_at` and `CELL_NS` already exist.) Register both in `main`, after the Task 8 tests:

```c
    RUN(the_hd_store_takes_only_an_hd_slot);
    RUN(an_hd_write_is_stored_and_served_back);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "COMPILE FAIL|FAIL" | head`
Expected: `COMPILE FAIL: test_write_back.c` (`psram_image_store_adf` undeclared).

- [ ] **Step 3: psram_image_store_adf**

In `wifi-floppy/firmware/src/psram_image.h` replace the `psram_image_mark_dirty` comment and declaration with:

```c
// Host wrote this track: keep the data, mark for later flush to the server.
// MFM only: does nothing on an ADF_HD slot, whose tracks hold ADF bytes and
// are stored with psram_image_store_adf.
void psram_image_mark_dirty(int slot, int track, const uint8_t *src, uint32_t bit_count);

// HD writes spec §4.3: a verified HD track's 11,264 ADF bytes
// (MFM_HD_TRACK_DATA_BYTES), stored DIRTY in an ADF_HD slot -- the HD twin of
// psram_image_mark_dirty. False, and nothing stored, for an MFM slot, an
// unusable slot or track, or no PSRAM. The caller drops the track's SRAM copy
// (track_cache_invalidate) so the next read re-encodes it.
bool psram_image_store_adf(int slot, int track, const uint8_t *adf);
```

In `wifi-floppy/firmware/src/psram_image.c` add `#include "mfm.h"` directly after `#include "psram_image.h"` (line 1; it is pure C, safe in the host build), change the line in `store()` to

```c
    if (kind[slot] == SLOT_KIND_ADF_HD) return;         // MFM never goes into an ADF slot (psram_image_store_adf)
```

and add after `psram_image_mark_dirty`:

```c
_Static_assert(MFM_HD_TRACK_DATA_BYTES <= TRACK_MAX_BYTES, "an HD track's ADF bytes fit a PSRAM track");

bool psram_image_store_adf(int slot, int track, const uint8_t *adf) {
    if (!have_psram || !slot_ok(slot) || track < 0 || track >= NUM_TRACKS) return false;
    if (kind[slot] != SLOT_KIND_ADF_HD) return false;
    memcpy(track_ptr(slot, track), adf, MFM_HD_TRACK_DATA_BYTES);
    bits[slot][track] = MFM_HD_TRACK_DATA_BYTES * 8u;
    wfmf_barrier();     // payload must be visible to core1 before the flag that tells it to read it
    state[slot][track] = TRK_DIRTY;
    return true;
}
```

- [ ] **Step 4: write_back_apply stores HD as it is**

In `wifi-floppy/firmware/src/write_back.h` replace the `write_back_apply` comment with:

```c
// Store a verified track in `slot` as DIRTY. DD (an MFM slot): encode
// `adf_track` (MFM_TRACK_DATA_BYTES) as a standard track. HD (an ADF_HD slot,
// HD writes spec §4.3): store its MFM_HD_TRACK_DATA_BYTES as they are; they
// are encoded on read. True if it landed.
```

In `wifi-floppy/firmware/src/write_back.c` make `write_back_apply`:

```c
bool write_back_apply(int slot, int track, const uint8_t *adf_track) {
    // HD writes spec §4.3: an HD slot holds ADF bytes and is encoded on read
    // (track_cache.c), so the verified sectors go in as they are. main.c's
    // track_cache_invalidate() after this makes the next read re-encode them.
    if (psram_image_slot_kind(slot) == SLOT_KIND_ADF_HD)
        return psram_image_store_adf(slot, track, adf_track);

    // Static: 12.6 KB would not fit core0's frame. Not re-entrant, and only
    // ever called from core0's service loop.
    static uint8_t mfm[MFM_TRACK_BYTES];
    const uint32_t bits = mfm_encode_track(adf_track, (uint8_t)track, mfm);
    psram_image_mark_dirty(slot, track, mfm, bits);
    return psram_image_state(slot, track) == TRK_DIRTY;
}
```

- [ ] **Step 5: Run the host tests and the device build**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -5; echo "exit=$?"
pnpm firmware:build 2>&1 | tail -3
```

Expected: `exit=0` (`the_hd_store_takes_only_an_hd_slot` also pins that `psram_image_mark_dirty` still refuses an ADF_HD slot); the device build succeeds.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/psram_image.h wifi-floppy/firmware/src/psram_image.c \
  wifi-floppy/firmware/src/write_back.h wifi-floppy/firmware/src/write_back.c wifi-floppy/firmware/test/test_write_back.c
git commit -F- <<'EOF'
firmware: a verified HD track is stored as ADF bytes in its ADF_HD slot; Greaseweazle end to end

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 11: Firmware — the uploader sends HD tracks and hashes the HD image

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h:421-424`, `wifi-floppy/firmware/src/uploader.c:174-201` (`up_read_whole_track`), `:219-256` (`up_send_track`'s read and POST), `:366-374` (`up_close`'s hash)
- Test: `wifi-floppy/firmware/test/test_uploader.c`

**Interfaces:**
- Consumes: Task 10's `psram_image_store_adf`; the existing `psram_image_track_data`, `psram_image_slot_kind`.
- Produces: an HD dirty track is POSTed as its 11,264 stored bytes; the close's sha-256 covers 160 × 11,264 bytes on an HD disk (160 × 5,632 on DD, unchanged). `DC_POST_BODY_MAX` = 11,264.

- [ ] **Step 1: Write the failing tests**

In `wifi-floppy/firmware/test/test_uploader.c` add after `amiga_writes` (line ~62):

```c
/* ---- HD (HD writes spec §4.4) ------------------------------------------- */

#define HB MFM_HD_TRACK_DATA_BYTES                // 11264
static uint8_t hd_adf[NUM_TRACKS * HB];          // the HD disk the board holds

// An HD disk in slot 0: an ADF_HD slot of ADF bytes (not MFM), every track
// present and clean. Otherwise exactly mounted().
static void mounted_hd(void) {
    fake_reset(); fake_set_clock(10000);
    wf_log_test_reset(); wf_log_test_set_sink(log_sink); logbuf[0] = '\0';
    psram_image_reset_slot(0); psram_image_reset_slot(1);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    for (int t = 0; t < NUM_TRACKS; t++) {
        for (int i = 0; i < HB; i++) hd_adf[t * HB + i] = (uint8_t)(t * 3 + i * 5);
        psram_image_write_at(0, t, 0, hd_adf + t * HB, HB);
        psram_image_commit(0, t, HB * 8u);
    }
    psram_publish_slot(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "h", "tok");
    strcpy(c.mounted_sha256, "aa"); strcpy(c.mounted_disk_id, "d1");
    c.mounted_version = 7; c.since = 7;
    gen = 0; last_ms = 10000; gen_moves = false;
    up_init(&u, &c, "boot-abc", write_gen, last_write);
}

static void amiga_writes_hd(int t, uint8_t fill) {
    memset(hd_adf + t * HB, fill, HB);
    CHECK(psram_image_store_adf(0, t, hd_adf + t * HB), "core0 stored the verified track");
    gen++; last_ms = fake_clock_ms();
}

static void hd_digest(char hex[65]) {
    sha256_t s; uint8_t d[32];
    sha256_init(&s); sha256_update(&s, hd_adf, sizeof hd_adf); sha256_final(&s, d);
    sha256_hex(d, hex);
}

static void an_hd_track_is_uploaded_as_its_stored_bytes(void) {
    mounted_hd();
    amiga_writes_hd(159, 0x5a);
    push_json("HTTP/1.1 200 OK", "{\"staged\":159}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(),
        "POST /api/device/write?disk=d1&mount=7&track=159&session=boot-abc&seq=1 HTTP/1.1") != NULL,
        "the protocol's query, verbatim");
    CHECK(strstr(fake_last_request(), "Content-Length: 11264") != NULL, "an HD track's 11,264 bytes");
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - HB, hd_adf + 159 * HB, HB) == 0,
          "the stored ADF bytes, byte for byte -- no re-decode");
    CHECK_EQ_INT(psram_image_state(0, 159), TRK_PRESENT);
}

static void an_hd_close_hashes_160_tracks_of_11264_bytes(void) {
    mounted_hd();
    amiga_writes_hd(40, 0x77);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    up_step(&u);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; hd_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    char line[256];
    snprintf(line, sizeof line,
        "POST /api/device/write/close?disk=d1&mount=7&session=boot-abc&seq=1&sha256=%s HTTP/1.1", want);
    CHECK(strstr(fake_last_request(), line) != NULL,
          "the digest of the HD image the server will hold: 160 x 11,264 bytes");
    CHECK(strcmp(c.mounted_sha256, want) == 0, "adopted, no re-fetch");
    CHECK(!u.open, "closed");
}

static void an_offline_hd_write_is_kept_and_sent_later(void) {
    mounted_hd();
    amiga_writes_hd(7, 0x33);
    fake_push_connect_failure();
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 7), TRK_DIRTY);
    CHECK_EQ_INT(up_sync(&u), UP_OFFLINE);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 200 OK", "{\"staged\":7}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - HB, hd_adf + 7 * HB, HB) == 0, "the same bytes, once back online");
    CHECK_EQ_INT(psram_image_state(0, 7), TRK_PRESENT);
}
```

Register them at the END of `main`'s `RUN` list (after `a_torn_track_during_the_hash_backs_off`), so every DD test runs first on a DD slot:

```c
    RUN(an_hd_track_is_uploaded_as_its_stored_bytes);
    RUN(an_hd_close_hashes_160_tracks_of_11264_bytes);
    RUN(an_offline_hd_write_is_kept_and_sent_later);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "COMPILE FAIL|FAIL|test_uploader" | head`
Expected: `test_uploader.c` compiles but FAILs its HD checks: no request is sent (`up_read_whole_track` hands an ADF_HD slot to `psram_image_read`, which refuses it, so every HD track reads as torn and is logged `upload: trk 159 torn, retrying`).

- [ ] **Step 3: DC_POST_BODY_MAX**

In `wifi-floppy/firmware/src/device_client.h` replace

```c
// Largest body dc_post will send in one call -- one head plus one track
// (see the STACK note in device_client.c for why the request buffer this
// backs is `static` and sized from this).
#define DC_POST_BODY_MAX 5632
```

with

```c
// Largest body dc_post will send in one call: one HD track's sector data,
// 11,264 bytes (HD writes spec §4.4; a DD track is 5,632). See the STACK note
// in device_client.c for why the request buffer this backs is `static` and
// sized from this: it costs 5.6 KB more than DD alone did.
#define DC_POST_BODY_MAX 11264
```

- [ ] **Step 4: up_read_whole_track and its two callers**

In `wifi-floppy/firmware/src/uploader.c` replace the comment above `up_read_whole_track` and the function itself with:

```c
_Static_assert(DC_POST_BODY_MAX >= MFM_HD_TRACK_DATA_BYTES, "dc_post must carry an HD track");

// Reads track `t` out of `slot` as the bytes the server keeps for it, into
// core1's own static buffer: `*len` bytes, or NULL if it could not be read
// whole. Shared by up_send_track (one track) and up_close's whole-image hash,
// so a torn read is resolved the same way in both.
//
// DD (an MFM slot): decoded, and NULL unless every sector came back,
// consistently numbered and matching `t` -- a torn read (core0 rewriting the
// track while this read is in progress) fails that and is never sent or
// hashed.
//
// HD (an ADF_HD slot, HD writes spec §4.4): the stored 11,264 bytes ARE the
// sector data, verified when core0 applied the write, so they are copied, not
// re-decoded. No checksum can catch a copy torn by core0's store, and none is
// needed: up_send_track clears the dirty flag BEFORE this copy and
// psram_image_store_adf sets it AFTER its own, so a track rewritten mid-copy
// is always sent again (the server keeps a track's last upload), and up_close
// re-checks write_gen() and the dirty flags after hashing. Copied, never
// handed to dc_post as a pointer into PSRAM that core0 may be writing.
static uint8_t *up_read_whole_track(int slot, int t, uint32_t *len) {
    static uint8_t trk[MFM_HD_TRACK_DATA_BYTES];
    if (psram_image_slot_kind(slot) == SLOT_KIND_ADF_HD) {
        const uint8_t *p = psram_image_track_data(slot, t);
        if (!p) return NULL;
        memcpy(trk, p, MFM_HD_TRACK_DATA_BYTES);
        *len = MFM_HD_TRACK_DATA_BYTES;
        return trk;
    }

    static uint8_t mfm[TRACK_MAX_BYTES];
    uint32_t bits = 0;
    psram_image_read(slot, t, mfm, &bits);

    memset(trk, 0, MFM_TRACK_DATA_BYTES);
    // Review (final), Critical C1: the re-entrant decoder, through core1's
    // OWN scratch. mfm_decode_track (no _r) is core0's -- its static
    // scratch is in use whenever core0 is decoding a captured write, which
    // can be exactly now. Static here for the STACK note above.
    static uint8_t scratch[MFM_DECODE_SCRATCH_BYTES];
    mfm_decode_result_t d;
    memset(&d, 0, sizeof d);
    mfm_decode_track_r(mfm, (size_t)((bits + 7u) / 8u), trk, &d, scratch);

    if (d.found != 0x7ffu || !d.track_no_consistent || d.track_no != (uint8_t)t)
        return NULL;
    *len = MFM_TRACK_DATA_BYTES;
    return trk;
}
```

In `up_send_track` replace `uint8_t *trk = up_read_whole_track(slot, t);` with

```c
    uint32_t tlen = 0;
    uint8_t *trk = up_read_whole_track(slot, t, &tlen);
```

and in the `dc_post(...)` call replace the body length argument `MFM_TRACK_DATA_BYTES` with `(int)tlen`.

In `up_close`'s loop replace

```c
        uint8_t *trk = up_read_whole_track(slot, t);
```

with

```c
        uint32_t tlen = 0;
        uint8_t *trk = up_read_whole_track(slot, t, &tlen);
```

and `sha256_update(&s, trk, MFM_TRACK_DATA_BYTES);` with `sha256_update(&s, trk, tlen);` (the digest covers 160 tracks at the disk's own track size, spec §4.4).

- [ ] **Step 5: Run the host tests and the device build**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -5; echo "exit=$?"
pnpm firmware:build 2>&1 | tail -3
```

Expected: `exit=0` (`test_device_client.c`'s `dc_post` test now sends an 11,264-byte body and still fits the fake transport's 16,384-byte request buffer); the device build succeeds.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/uploader.c wifi-floppy/firmware/test/test_uploader.c
git commit -F- <<'EOF'
firmware: uploader posts HD tracks' stored bytes and hashes 160 x 11,264 at close

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 12: Firmware — WPROT follows the server for HD

**Files:**
- Modify: `wifi-floppy/firmware/src/write_back.h:40-45`, `wifi-floppy/firmware/src/write_back.c` (`write_back_wprot`), `wifi-floppy/firmware/src/main.c:1744-1779` (the WPROT computation, its comment and its log line)
- Test: `wifi-floppy/firmware/test/test_write_back.c` (`wprot_is_forced_for_an_hd_disk`)

**Interfaces:**
- Consumes: Tasks 8-11 (an HD write now decodes, stores and uploads; releasing WPROT before them would have let the Amiga write into a disk the board discarded).
- Produces: `bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced)`.

- [ ] **Step 1: Write the failing test**

In `wifi-floppy/firmware/test/test_write_back.c` replace `wprot_is_forced_for_an_hd_disk` with:

```c
// HD writes spec §4.5: three gates, DD and HD alike. The read-only-image term
// 1.4.x had for HD is gone; a board that still has it is a 1.4.x board.
static void wprot_follows_three_gates(void) {
    CHECK(!write_back_wprot(true, false, false), "mounted, writable, nothing forcing: released");
    CHECK(write_back_wprot(false, false, false), "nothing mounted: protected");
    CHECK(write_back_wprot(true, true, false), "the server's flag");
    CHECK(write_back_wprot(true, false, true), "the uploader's force");
}
```

and in `main` replace `RUN(wprot_is_forced_for_an_hd_disk);` with `RUN(wprot_follows_three_gates);`.

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "COMPILE FAIL" | head`
Expected: `COMPILE FAIL: test_write_back.c` (too few arguments to `write_back_wprot`).

- [ ] **Step 3: Implement**

In `wifi-floppy/firmware/src/write_back.h` replace the `write_back_wprot` comment and declaration with:

```c
// Whether WPROT is asserted: nothing mounted, the server's flag, or the
// uploader's force (up_forces_wprot). An HD disk follows the same three (HD
// writes spec §4.5); 1.4.x also forced it for HD, whatever the server sent.
// Pure; main.c's core1 loop feeds it and drives the pin.
bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced);
```

In `wifi-floppy/firmware/src/write_back.c` replace `write_back_wprot` with:

```c
bool write_back_wprot(bool mounted, bool server_protected, bool uploader_forced) {
    return !mounted || server_protected || uploader_forced;
}
```

In `wifi-floppy/firmware/src/main.c` replace

```c
            bool up_forced = up_forces_wprot(&up);
            // HD spec §5.3: an HD disk is read-only here, and not only because
            // the server sends writeProtected: the board holds the line itself.
            bool hd_mounted = mounted &&
                psram_image_slot_kind(psram_active_slot()) == SLOT_KIND_ADF_HD;
            bool wprot = write_back_wprot(mounted, c.mounted_write_protected, up_forced, hd_mounted);
```

with

```c
            bool up_forced = up_forces_wprot(&up);
            // HD writes spec §4.5: an HD disk follows the same three gates as
            // DD. (1.4.x held WPROT for HD whatever the server sent.)
            bool wprot = write_back_wprot(mounted, c.mounted_write_protected, up_forced);
```

In the comment block below it replace `FOUR separate gates force WPROT -- no disk, the server's flag, the uploader (up_forces_wprot: after a refused write, or while parked) and an HD image -- and none folds into another` with `THREE separate gates force WPROT -- no disk, the server's flag and the uploader (up_forces_wprot: after a refused write, or while parked) -- and none folds into another`, and replace the log call with:

```c
                wf_logf(WF_INFO, "wprot: %s (mounted=%s server=%s uploader=%s)",
                        wprot ? "ASSERTED -- the Amiga cannot write" : "RELEASED -- the Amiga may write",
                        mounted ? "yes" : "no",
                        mounted ? (c.mounted_write_protected ? "protected" : "writable") : "n/a",
                        up_forced ? "forced" : "ok");
```

- [ ] **Step 4: Run the host tests and the device build**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -5; echo "exit=$?"
pnpm firmware:build 2>&1 | tail -3
grep -n "SLOT_KIND_ADF_HD" wifi-floppy/firmware/src/main.c
```

Expected: `exit=0`; the build succeeds; the grep shows only the verify sweep's skip and the drive-ID lines (`const bool hd = …`), nothing in the WPROT code.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/write_back.h wifi-floppy/firmware/src/write_back.c \
  wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/test_write_back.c
git commit -F- <<'EOF'
firmware: WPROT follows the server's flag for HD too (the read-only term is gone)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

---

### Task 13: Firmware 1.5.0, README, HANDOFF with the bench checklist, full verification

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt:166`, `README.md` (lines 11, 31-32, 59-62, the "How it works" HD paragraph at ~97-100, the Status table at ~112-122), `HANDOFF.md` (the "Where things stand" row at line 62; a new section `### 3ao.` directly before `### 3an.` at line 4459)

**Interfaces:**
- Consumes: everything above.
- Produces: a 1.5.0 build in `wifi-floppy/firmware/build/` (the controller installs it on the bench board and, after bench steps 1 and 2 pass, publishes it), and the bench checklist the operator runs.

- [ ] **Step 1: Bump the version and build**

In `wifi-floppy/firmware/CMakeLists.txt` change `set(FIRMWARE_SEMVER "1.4.1")` to `set(FIRMWARE_SEMVER "1.5.0")`. Then:

```bash
pnpm firmware:build 2>&1 | tail -3
grep WF_FIRMWARE_VERSION wifi-floppy/firmware/build/generated/wifi_floppy_version.h
wifi-floppy/firmware/test/run.sh 2>&1 | tail -3; echo "exit=$?"
```

Expected: a clean build, a version string starting `1.5.0+g` (a `-dirty` suffix until this commit is made; the controller rebuilds from the committed tree), and `exit=0`.

- [ ] **Step 2: README**

In `README.md`:
- Line 11: change `behaves like a floppy drive (DD, and HD read-only), and plays whichever disk you pick in the web app.` to `behaves like a DD or HD floppy drive, and plays whichever disk you pick in the web app.`
- Lines 31-32: replace the bullet `- HD (1.76 MB) ADFs are recognised and tagged HD. They play on the Amiga read-only; they can't be browsed or edited in the browser yet.` with `- HD (1.76 MB) ADFs are recognised and tagged HD, and are disks like any other: browsed and edited in the browser, with full history. Blank HD disks can be made from the Create ADF menu.`
- Lines 59-62: replace the bullet beginning `- Plays HD disks read-only:` with `- Plays HD disks: the board tells the Amiga it is an HD drive while an HD disk is in. Needs Kickstart 3.0 or later. Playing needs firmware 1.4.1 or later (the web app refuses to mount an HD disk on older firmware and says so); saving to an HD disk needs 1.5.0 (1.4.x keeps HD write-protected on the board whatever the web app says).`
- After the "How it works" paragraph that ends `with the HD ID while an HD disk is mounted.`, add: `When the Amiga saves to an HD disk, the board checks all 22 sectors of the written track, keeps them as ADF bytes, and uploads those bytes as they are.`
- In the Status table, after the row `| HD disks, read-only (Kickstart 3.0+) | verified on hardware (firmware 1.4.1, Kickstart 3.1) |`, add `| HD disks: Amiga saves, history, browser editing, blank HD disks | built and host-tested (firmware 1.5.0, not yet published); bench checklist owed (HANDOFF 3ao) |`.

- [ ] **Step 3: HANDOFF — the table row, the section and the bench checklist**

In `HANDOFF.md`, replace the "Where things stand" row that begins `| **HD floppies, read-only** |` with:

```markdown
| **HD floppies, read-only** | ✅ **merged; firmware 1.4.1 verified on hardware 2026-09-27** (A5000, Kickstart 3.1); see 3an |
| **HD disks: writes, history, editing, blank disks** | 🟡 **built on `feat/hd-writes`, not merged.** Web done and e2e green; firmware 1.5.0 built and host-tested, not published; bench checklist owed; see 3ao |
```

Insert directly before the line that begins `### 3an. HD floppies, read-only -- 2026-09-26`:

````markdown
### 3ao. HD disks: Amiga writes, full history, browser editing, blank HD disks -- 2026-09-27 (spec/plan 2026-09-27-hd-writes-and-editing)

**STATUS: built on `feat/hd-writes`; web e2e green; firmware 1.5.0 built and host-tested; NOT merged, NOT
published, bench checklist below owed.** Spec `docs/superpowers/specs/2026-09-27-hd-writes-and-editing-design.md`,
plan `docs/superpowers/plans/2026-09-27-hd-writes-and-editing.md` (its "Rulings" section lists every call made
while planning).

What it does:
- adffs reads an image's geometry from its length (`src/lib/adffs/geometry.ts`): DD 1,760 blocks / root 880, HD
  3,520 / root 1,760, one bitmap block on both. Every read, write, allocate and format path takes it;
  `readVolume` returns `rootBlock`, and the file browser's controls send it. `pnpm adffs:verify` cross-checks HD
  with xdftool both ways (as `.hdf`: amitools 0.4.0's ADF device is DD-only).
- History takes its sector count (1,760/3,520) and track size (5,632/11,264) from the image; the WDLD format is
  unchanged; a disk's versions are all one size (`size_mismatch`). The write route takes 11,264-byte tracks for
  an HD disk and 400s the other density's size.
- Every HD refusal is gone: the write-protect toggle, the drive chips, the file browser, file edits, volume
  rename, restore, and `readDesired` (an HD disk is sent writable when its row is). `plays_hd` and
  `hd_unsupported` stay. Blank HD disks: "Create HD ADF (FFS/OFS)" in the create menu.
- Firmware 1.5.0: capture window 800 ms and buffer 32 KB (sized for the write's lead gap, not just the track;
  the spec said 28 KB); the decoder is told the mounted disk's sector count (11/22) and counts good sectors
  numbered past it (`WB_REJECT_DENSITY`: an HD track on a DD disk); a verified HD track goes into its `ADF_HD`
  slot as ADF bytes (`psram_image_store_adf`); the uploader posts those bytes and hashes 160 x 11,264 at close;
  `DC_POST_BODY_MAX` is 11,264; WPROT follows the server for HD.
- **Older boards:** a 1.4.1 board still asserts WPROT for HD itself. An HD disk set writable in the web app is
  still protected on such a board until it updates to 1.5.0. No capability flag; this note and the README are
  the documentation.
- New or changed log lines to read on the bench: `write: trk N <iv> iv <bytes> B sec 0x3fffff/22 ALL bad 0
  foreign 0 …` (the `B` figure is the capture size), `write: trk N rejected: not all 22 sectors verified` /
  `sectors numbered past 11: an HD track on a DD disk`, `wprot: … (mounted=… server=… uploader=…)` (no `hd=`
  field any more), and `heap: free low-water N bytes`.

**Bench prep (controller):**
1. Deploy the web app first (merge to master ships it). 1.4.1 boards keep protecting HD, so this is safe.
2. Build 1.5.0 from the committed tree and install it on the bench board **without** publishing it to the
   registry. Publish (`pnpm firmware:publish --notes "HD disks: saves, history"`) only after bench steps 1 and 2
   pass (spec §9).
3. The HD Workbench test disk from 3an (`HDBench.adf`, `scripts/hd-test-disk.sh`) is in the library. Set it
   writable in the web app. Have a DD Workbench 3.1 disk, set writable, for step 1.

**Bench checklist (A5000 rev 8a.1, Kickstart 3.1; each step a visible pass or fail; one physical step per turn):**
1. DD regression: the DD Workbench disk boots, and `Echo >DF0:ddcheck hi` makes a new version in the library.
2. HD save: boot the HD Workbench disk; `Echo >DF0:hello hi` and `Copy RAM:HDCheck.txt DF0:copy.txt` (copy
   HDCheck.txt to RAM: first). The log shows `sec 0x3fffff/22 ALL` per written track and no `rejected`; the new
   version appears in the history panel with `hello` and `copy.txt` added, and both can be opened in the browser.
3. Large write: `Copy` a several-hundred-KB file onto the HD disk. Every `write: trk` line says `ALL`; the
   library's newest version matches (its file opens and has the right size). Record the largest `… B` figure
   from the `write: trk` lines here (the capture size; the buffer is 32,768).
4. Offline: switch WiFi off, save to the HD disk, switch it back on. The version arrives.
5. Memory: record the lowest `heap: free low-water` line during steps 2-4 here. It must stay well above what
   TLS needs (it was 69,632 after TLS on 1.4.1; this release adds ~33 KB of static buffers, so ~36 KB is expected).
6. Restore: put an older HD version back from the history panel (eject first); the Amiga sees it after the
   disk change.
````

- [ ] **Step 4: Full verification**

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit -p . && pnpm lint && pnpm build
wifi-floppy/firmware/test/run.sh 2>&1 | tail -3; echo "exit=$?"
pnpm adffs:verify 2>&1 | tail -1
pnpm hw:verify
```

Expected: every command succeeds; `adffs:verify` ends `All checks passed.`; `hw:verify` passes unchanged (no hardware file was touched).

Then the **full e2e suite**, the operator's merge bar. Run it in the foreground on `PORT=3100`, never beside another e2e run, in invocations that each finish in under 9 minutes. List the specs with `ls e2e/*.spec.ts` (55 files), then run them in groups of about 6:

```bash
PORT=3100 pnpm exec playwright test <group of about 6 spec files from `ls e2e/*.spec.ts`> --reporter=line
```

If a group runs past ~8 minutes, split it further. Record per group: files, passed, failed. For any failure, re-run that one spec alone before calling it a regression: a dirty environment (an orphaned dev server, another session's run) has twice been mistaken for a code regression here. When done, stop the dev server on 3100 by its PID only.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/CMakeLists.txt README.md HANDOFF.md
git commit -F- <<'EOF'
firmware 1.5.0: HD disks take Amiga saves; README and HANDOFF 3ao with the bench checklist

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
EOF
```

Report to the controller: the 1.5.0 version string, the full-e2e totals per group, and that installing, publishing and the bench checklist are theirs.

---

## Self-review (done while writing; kept for the reviewers)

- **Spec coverage.**
  - §1 done-means and §8 bench: Task 13's checklist (steps 1-6 = spec §8 steps 1-6, plus the capture-size and heap records).
  - §2 decisions: full history (Task 3), editing and blank disks in this project (Tasks 5-7), DD/HD choice beside OFS/FFS with DD default (Task 7), write-protected by default (unchanged; Task 6 e2e asserts it), older boards documented (Task 13), out of scope untouched.
  - §4.1 capture: Task 9 (800 ms; 32,768 bytes — a ruling). §4.2 decode and verdict: Task 8. §4.3 store: Task 10. §4.4 upload: Task 11 (plus `DC_POST_BODY_MAX`, a ruling). §4.5 WPROT: Task 12; `WB_REJECT_READ_ONLY` removed in Task 8. §4.6 1.5.0: Task 13.
  - §5.1 uploads: Task 4. §5.2 history: Task 3 (and restore of HD in Task 5, browsing and diff via Task 1's reader). §5.3 read-only removed: Task 4 (`device-write.ts`), Task 5 (`readDesired`, PATCH, `disk-write.ts`, `restore.ts`, `volume-name`, `files/batch`, `files/[block]`), Task 6 (toggle, chips, file browser, messages). §5.4: Task 13. No migration.
  - §6.1 geometry: Task 1. §6.2 editing: Tasks 5-6 (add, rename, move, delete, batch, volume name, free-space bar via `readUsage`). §6.3 blank HD: Task 7. §6.4 xdftool both ways: Task 2.
  - §7 tests: adffs vitest (Task 1) and xdftool (Task 2); history vitest (Task 3); write route (Task 3 vitest for sizes and overlay, Task 4 e2e for the route and the close); firmware host — Greaseweazle HD track through decode → verdict → store → served track (Task 10) and uploader read-back (Task 11), capture fits (Task 9), DD rejects 22 / HD rejects 11 (Task 8); e2e — blank HD disk, add and rename, versions (Task 7), simulated board's HD session (Task 4), restore an older HD version (Tasks 5 and 7).
  - §9 rollout: Task 13's bench prep (web first; publish after bench 1-2).
- **Placeholders.** None. `<group of about 6 spec files …>` in Task 13 is the grouping the step tells you to make from `ls e2e/*.spec.ts`.
- **Type consistency.** Used identically everywhere: `geometryOf`, `geometryFor`, `DD_GEOMETRY`, `HD_GEOMETRY`, `BITMAP_FIRST_BLOCK`, `rootBlock` (on `readVolume`'s ok result and in `useFileEdit()`), `formatVolume({ density })`, `isHistoryImage`, `MAX_SECTORS_PER_DISK`, `shouldSnapshot(n, imageBytes)`, `nextKind(n, d, imageBytes)`, `trackBytesForImage`, `trackBytesForDisk`, `isTrackUpload(track, data, trackBytes)`, `size_mismatch`, `MFM_HD_SECTORS`, `MFM_MAX_SECTORS`, `MFM_HD_TRACK_DATA_BYTES`, `foreign_sectors`, `mfm_decode_track_n`, `mfm_decode_track_rn`, `write_back_sectors`, `write_back_mask`, `write_back_reason(v, nsec)`, `WB_REJECT_DENSITY`, `FLUX_CAPTURE_MAX_MS`, `FLUX_CAPTURE_BUF_BYTES`, `psram_image_store_adf`, `up_read_whole_track(slot, t, &len)`, `DC_POST_BODY_MAX`, `write_back_wprot(mounted, server, uploader)`, `create-adf-hd-ffs` / `create-adf-hd-ofs`, `createAdf(page, fs, density)`.
- **Review Focus.** Each of the five has its test in the owning task: 1 → Task 4 (both e2e specs); 2 → Task 1 (vitest `moveEntry` onto 880) and Task 5 (e2e, `parentBlock: 880` and `toParent: 880`); 3 → Task 1 (vitest, allocate to full and `disk-full`); 4 → Task 3 (vitest threshold, 1,000-sector plan, track-159 overlay) and Task 4 (e2e track 159); 5 → Task 3 (vitest `size_mismatch`).
- **Task order.** Web (1-7) and firmware (8-12) are independent until Task 13. Inside the firmware, WPROT is released last (Task 12), so no intermediate build lets the Amiga write an HD track the board would then discard.
