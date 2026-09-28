# Multi-disk "Next disk" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person move a board to the next disk of the mounted multi-disk title, from the web or with a universal Next-disk NFC card, and make that swap near-instant by preloading the next disk into the board's idle PSRAM slot.

**Architecture:**
- One pure server rule (`nextDisk`) decides what "next" is. The tap endpoint, a new web endpoint and the poll all use it.
- The poll tells the board which disk comes next. The board preloads it into its inactive slot without publishing it, and publishes it instantly when that disk becomes desired.
- The Next-disk card is a WFDK version-2 tag carrying `next` instead of a disk id.

**Tech Stack:** Next.js (app router; read `node_modules/next/dist/docs/` before touching routes), Drizzle + Neon Postgres, zod, vitest, Playwright, Base UI; RP2350 C firmware with host tests in `wifi-floppy/firmware/test/run.sh`.

**Spec:** `docs/superpowers/specs/2026-09-28-multi-disk-next-design.md` (approved 2026-09-28).

## Global Constraints

- Branch `feat/multi-disk-next` off `master`. Never commit to master directly; never `git stash`; never `git add -A` (stage explicit paths). Other sessions change this tree: run `git status` before staging.
- e2e: only `PORT=3100`, foreground only (Bash timeout 540000). Split runs so that none takes more than ~9 minutes. Never run two e2e runs at once: the live production DB is shared.
- Never `pkill`/`killall` by pattern; stop only PIDs you started.
- Migrations are additive and guarded (`ADD COLUMN IF NOT EXISTS`), numbered `0027_…`, applied to the live DB before e2e (as with 0025/0026).
- The poll body must fit `DC_POLL_BODY_BYTES` (1536). `src/lib/device-limits.test.ts` computes the worst case and must stay green.
- The status body must fit `DC_STATUS_BODY_BYTES`. The firmware test `test_status_body_fits_at_maximum` must stay green.
- Old firmware must be safe:
  - an unknown poll field is ignored;
  - a v2 tag decodes as `NFC_TAG_BAD_DATA`;
  - an `nfcWrite` with `diskId: null` is a disarm.
- Org scoping: every web route answers 404 `not_found` for another org's board. Device routes use the token's org, never a body org.
- Tap outcomes: always HTTP 200 with an `outcome` (D4).
- Firmware version becomes `1.6.0` (`FIRMWARE_SEMVER` in `wifi-floppy/firmware/CMakeLists.txt`).
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UNftEdmHHNsd183JnmeBPD
  ```

## Execution order

Tasks 1-4, then **6 before 5** (the poll uses Task 6's `nfcWriteForPoll` kind), then 7-14.

## Rulings made while planning (deviations from the spec's wording)

- **R1: `next` in the poll is minimal.** It is `{diskId, sha256, diskNo}`, not "the same shape as `desired`". The worst-case poll body today has 319 bytes spare; a full `desired`-shaped object is ~350 bytes and would break boards. The OLED line comes from the tap response, not from the poll.
- **R2: freshness of `next`.** The poll only returns a body when a cursor moves. A browser edit to disk N+1 therefore reaches the board at the next version bump, not at once. The swap-time sha256 comparison (spec §4.4) is what guarantees stale bytes are never published. A stale preload costs one normal fetch, nothing more.
- **R3: preload state `none`.** The status report sends `"preload":null` when nothing is preloaded. The server stores `preload_state = 'none'`, so "board reports nothing" (`'none'`) and "board too old to report" (NULL) stay distinct. The UI shows "Disk N ready (instant swap)" only when the state is `ready` and the sha256 matches `next`, "Disk N loading…" for any other non-NULL state, and nothing for NULL.
- **R4: M in "Disk N of M"** is the number of distinct disk numbers in the title.
- **R5: "oldest" duplicate is the lowest `id`.** The spec says the oldest (`createdAt`, then `id`), but `disks` has no timestamp column (checked in `src/db/schema/catalog.ts`). The lowest id is deterministic and stable, which is what the rule needs; adding a column for this alone is not worth a migration.

## Review Focus

1. **The `next` object's `sha256`/`diskId` keys shadowing `desired`'s in the firmware's flat JSON scans.** `next` must be lifted out (blanked) before `dc_handle_poll_body` reads `sha256`. Test: a poll body with `next` placed BEFORE `desired` still fetches `desired.sha256` (Task 11).
2. **A preload published while disk N has unsent writes, or a regular fetch landing in the preloaded slot without dropping the record.** Either would publish wrong bytes. Tests: no preload while the hold predicate is true; any `dc_fetch_image` invalidates the record (Task 11).
3. **A cancelled Next-disk write leaving `nfc_write_kind = 'next'`,** so a later disk-id request, or its disarm, is delivered as a Next-card write. Test: cancel resets the kind; a disarm carries no `kind` (Task 6).
4. **Taps counted from the mounted disk instead of the wanted one.** Two taps during one swap would then land on the same disk. Test: `desiredDiskId` wins over `mountedDiskId` (Task 2).
5. **The poll body over budget with `next` and `nfcWrite.kind` both present.** Test: `device-limits.test.ts` worst case includes both (Task 5).

---

## File Structure

**Server (new):**
- `src/lib/next-disk.ts`: the pure rule `nextDisk`, `boardHolds`, `nextInfo`, and the DB loader `readNextForDevices`.
- `src/app/api/devices/[id]/next/route.ts`: the web "Next disk" action.

**Server (modified):**
- `src/db/schema/devices.ts`, `drizzle/0027_multi_disk_next.sql`, `drizzle/meta/_journal.json`: three columns.
- `src/lib/nfc/rules.ts`, `src/lib/nfc/store.ts`: `TapOutcome` additions, `tapNext`, and the write kind.
- `src/app/api/device/tap/route.ts`: `{action:'next'}`.
- `src/app/api/device/poll/route.ts`: the `next` field and `nfcWrite.kind`.
- `src/app/api/nfc/write/route.ts`: `{kind:'next'}`.
- `src/app/api/device/status/route.ts`, `src/lib/mount.ts`: `preload`.
- `src/lib/device-limits.test.ts`: the budget.

**Web (modified):**
- `src/lib/live-state.ts`, `src/lib/drive-chips.ts`, `src/components/shell/drive-chips.tsx`: the chip menu.
- `src/lib/queries.ts`, `src/components/devices/device-card.tsx`, `src/components/devices/device-list.tsx`, `src/components/devices/device-actions.ts`, `src/app/(app)/devices/page.tsx`: the card.
- `src/components/nfc/fob-button.tsx`: `mode: 'next'`.

**Firmware (modified):**
- `nfc_tag.[ch]`: v2 payload.
- `nfc_reader.[ch]`: `NFC_EV_TAG_NEXT` and `nfc_arm_write_next`.
- `device_client.[ch]`:
  - `next` lift;
  - preload state and fetch;
  - swap from preload;
  - `dc_tap_next`;
  - `preload` in status;
  - `nfcWrite.kind`.
- `nfc_ui.[ch]`: lines.
- `main.c`: wiring.
- `CMakeLists.txt`: version.
- `test/test_nfc_tag.c`, `test/test_nfc_reader.c`, `test/test_device_client.c`, `test/test_nfc_ui.c`.

**e2e (new):** `e2e/next-disk.spec.ts`.

---

### Task 1: Migration and schema columns

**Files:**
- Modify: `src/db/schema/devices.ts` (after line 116, `lastTapOutcome`)
- Create: `drizzle/0027_multi_disk_next.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 27)

**Interfaces:**
- Produces:
  - `devices.nfcWriteKind: text, NOT NULL, default 'disk'`;
  - `devices.preloadSha256: text | null`;
  - `devices.preloadState: text | null` (`'loading' | 'ready' | 'none'`, NULL = firmware too old).

- [ ] **Step 1: Add the columns to the Drizzle schema.** In `src/db/schema/devices.ts`, directly after `lastTapOutcome: text('last_tap_outcome'),`:

```ts
  // What an armed NFC write puts on the tag (multi-disk spec §3.4): 'disk' =
  // nfcWriteDiskId, 'next' = the universal Next-disk card (no disk id).
  nfcWriteKind: text('nfc_write_kind').notNull().default('disk'),
  // What the board says its idle slot holds (spec §3.5, plan R3): 'loading',
  // 'ready', or 'none' (it reported nothing preloaded). NULL = firmware too
  // old to report -- the UI then says nothing rather than guessing.
  preloadSha256: text('preload_sha256'),
  preloadState: text('preload_state'),
```

- [ ] **Step 2: Write the migration** `drizzle/0027_multi_disk_next.sql`:

```sql
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_kind" text DEFAULT 'disk' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "preload_sha256" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "preload_state" text;
```

- [ ] **Step 3: Append to `drizzle/meta/_journal.json` entries:**

```json
    {
      "idx": 27,
      "version": "7",
      "when": 1790600000000,
      "tag": "0027_multi_disk_next",
      "breakpoints": true
    }
```

- [ ] **Step 4: Typecheck.** Run `npx tsc --noEmit -p .`. Expected: no output.

- [ ] **Step 5: Commit.**

```bash
git add src/db/schema/devices.ts drizzle/0027_multi_disk_next.sql drizzle/meta/_journal.json
git commit -m "db: nfc_write_kind, preload_sha256, preload_state (multi-disk next)"
```

(The migration is applied to the live DB in Task 14, before e2e.)

---

### Task 2: The next-disk rule and its loader

**Files:**
- Create: `src/lib/next-disk.ts`
- Test: `src/lib/next-disk.test.ts`

**Interfaces:**
- Consumes: `isServable`, `isHdAdf` (`src/lib/disk-format.ts`), `LEGACY_BOARD_TRACK_MAX_BYTES` (`src/lib/adfmfm/constants.ts`).
- Produces:
  ```ts
  export type NextCandidate = { id: string; diskNo: number; sha256: string;
    imageFormat: string; sizeBytes: number; maxTrackBits: number | null };
  export type BoardCaps = { trackMaxBytes: number | null; playsHd: boolean };
  export type NextResult =
    | { kind: 'disk'; disk: NextCandidate; diskCount: number; wraps: boolean }
    | { kind: 'single' } | { kind: 'nothing_mounted' };
  export function boardHolds(d: NextCandidate, b: BoardCaps): boolean;
  export function nextDisk(disks: NextCandidate[], currentId: string | null, b: BoardCaps): NextResult;
  export type NextDeviceInput = { id: string; desiredDiskId: string | null; mountedDiskId: string | null } & BoardCaps;
  export async function readNextForDevices(orgId: string, devs: NextDeviceInput[]): Promise<Map<string, NextResult>>;
  export type NextInfo = { diskNo: number; diskCount: number; wraps: boolean; preload: 'ready' | 'loading' | null };
  export function nextInfo(r: NextResult | undefined, preloadSha256: string | null, preloadState: string | null): NextInfo | null;
  ```

- [ ] **Step 1: Write the failing tests** `src/lib/next-disk.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextDisk, nextInfo, type NextCandidate, type BoardCaps } from './next-disk';

const DD = 901_120, HD = 1_802_240;
let n = 0;
const disk = (diskNo: number, o: Partial<NextCandidate> = {}): NextCandidate => ({
  id: `d${String(++n).padStart(3, '0')}`, diskNo, sha256: `${n}`.padStart(64, '0'),
  imageFormat: 'adf', sizeBytes: DD, maxTrackBits: null, ...o,
});
const board: BoardCaps = { trackMaxBytes: 14336, playsHd: true };

describe('nextDisk', () => {
  it('goes to the next disk number', () => {
    const [a, b, c] = [disk(1), disk(2), disk(3)];
    const r = nextDisk([a, b, c], a.id, board);
    expect(r).toEqual({ kind: 'disk', disk: b, diskCount: 3, wraps: false });
  });
  it('wraps from the last disk to the first', () => {
    const [a, b] = [disk(1), disk(2)];
    expect(nextDisk([a, b], b.id, board)).toEqual({ kind: 'disk', disk: a, diskCount: 2, wraps: true });
  });
  it('is order-independent in its input', () => {
    const [a, b, c] = [disk(1), disk(2), disk(3)];
    expect(nextDisk([c, a, b], a.id, board)).toMatchObject({ disk: b });
  });
  it('says single for a one-disk title', () => {
    const a = disk(1);
    expect(nextDisk([a], a.id, board)).toEqual({ kind: 'single' });
  });
  it('says nothing_mounted with no current disk, or one not in the list', () => {
    const a = disk(1);
    expect(nextDisk([a], null, board)).toEqual({ kind: 'nothing_mounted' });
    expect(nextDisk([a], 'gone', board)).toEqual({ kind: 'nothing_mounted' });
  });
  it('collapses a duplicate disk number to the lowest id (plan R5)', () => {
    const a = disk(1);
    const b1 = disk(2, { id: 'b-low' });
    const b2 = disk(2, { id: 'z-high' });
    expect(nextDisk([a, b2, b1], a.id, board)).toMatchObject({ disk: b1, diskCount: 2 });
  });
  it('counts from a non-canonical duplicate by its disk number', () => {
    const a = disk(1), b1 = disk(2), b2 = disk(2), c = disk(3);
    expect(nextDisk([a, b1, b2, c], b2.id, board)).toMatchObject({ disk: c });
  });
  it('skips a disk this board cannot hold, and HD on a board without playsHd', () => {
    const a = disk(1), hd = disk(2, { sizeBytes: HD }), c = disk(3);
    expect(nextDisk([a, hd, c], a.id, { trackMaxBytes: 14336, playsHd: false })).toMatchObject({ disk: c });
    const long = disk(2, { imageFormat: 'hfe', maxTrackBits: 14336 * 8 + 1 });
    expect(nextDisk([a, long, c], a.id, board)).toMatchObject({ disk: c });
  });
  it('treats a board with no reported limit as the legacy 13312', () => {
    const a = disk(1), hfe = disk(2, { imageFormat: 'hfe', maxTrackBits: 13_500 * 8 });
    expect(nextDisk([a, hfe], a.id, { trackMaxBytes: null, playsHd: false })).toEqual({ kind: 'single' });
  });
  it('skips an unservable disk', () => {
    const a = disk(1), junk = disk(2, { sizeBytes: 1234 }), c = disk(3);
    expect(nextDisk([a, junk, c], a.id, board)).toMatchObject({ disk: c });
  });
});

describe('nextInfo', () => {
  const [a, b] = [disk(1), disk(2)];
  const r = nextDisk([a, b], a.id, board);
  it('is null for single and nothing_mounted', () => {
    expect(nextInfo({ kind: 'single' }, null, null)).toBeNull();
    expect(nextInfo(undefined, null, null)).toBeNull();
  });
  it('reports ready only when the preloaded sha is the next disk', () => {
    expect(nextInfo(r, b.sha256, 'ready')).toEqual({ diskNo: 2, diskCount: 2, wraps: false, preload: 'ready' });
    expect(nextInfo(r, a.sha256, 'ready')?.preload).toBe('loading');
    expect(nextInfo(r, null, 'none')?.preload).toBe('loading');
    expect(nextInfo(r, b.sha256, 'loading')?.preload).toBe('loading');
  });
  it('says nothing about preloading for a board too old to report', () => {
    expect(nextInfo(r, null, null)?.preload).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.** `npx vitest run src/lib/next-disk.test.ts`. Expected: FAIL, cannot find module `./next-disk`.

- [ ] **Step 3: Implement** `src/lib/next-disk.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { isHdAdf, isServable } from '@/lib/disk-format';
import { LEGACY_BOARD_TRACK_MAX_BYTES } from '@/lib/adfmfm/constants';

/**
 * "Next disk" (multi-disk spec §2): the one rule the tap, the web action and
 * the poll all use, so the board, the chip and the card can never disagree
 * about what "next" is.
 */
export type NextCandidate = {
  id: string; diskNo: number; sha256: string;
  imageFormat: string; sizeBytes: number; maxTrackBits: number | null;
};
export type BoardCaps = { trackMaxBytes: number | null; playsHd: boolean };
export type NextResult =
  | { kind: 'disk'; disk: NextCandidate; diskCount: number; wraps: boolean }
  | { kind: 'single' }
  | { kind: 'nothing_mounted' };

/** The same two checks setDesired makes in its UPDATE (mount.ts), in JS. */
export function boardHolds(d: NextCandidate, b: BoardCaps): boolean {
  if (!isServable(d)) return false;
  if (isHdAdf(d) && !b.playsHd) return false;
  if (d.maxTrackBits !== null && (b.trackMaxBytes ?? LEGACY_BOARD_TRACK_MAX_BYTES) * 8 < d.maxTrackBits) return false;
  return true;
}

// Plan R5: disks has no timestamp, so a duplicate disk number resolves to the lowest id.
const older = (a: NextCandidate, b: NextCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function nextDisk(all: NextCandidate[], currentId: string | null, b: BoardCaps): NextResult {
  const current = currentId ? all.find((d) => d.id === currentId) : undefined;
  if (!current) return { kind: 'nothing_mounted' };
  const diskCount = new Set(all.map((d) => d.diskNo)).size;
  // One row per disk number -- the oldest -- among the disks this board can hold.
  const byNo = new Map<number, NextCandidate>();
  for (const d of [...all].filter((x) => boardHolds(x, b)).sort(older)) {
    if (!byNo.has(d.diskNo)) byNo.set(d.diskNo, d);
  }
  const canon = [...byNo.values()].sort((x, y) => x.diskNo - y.diskNo);
  const after = canon.find((d) => d.diskNo > current.diskNo);
  const target = after ?? canon[0];
  if (!target || target.diskNo === current.diskNo) return { kind: 'single' };
  return { kind: 'disk', disk: target, diskCount, wraps: !after };
}

export type NextDeviceInput = { id: string; desiredDiskId: string | null; mountedDiskId: string | null } & BoardCaps;

/**
 * The next disk for each of `devs`, in two queries whatever their number:
 * the current disks, then every disk of their titles. Org-scoped on both.
 * "Current" is the WANTED disk, falling back to the mounted one (spec §2),
 * so a second tap during a swap moves one further.
 */
export async function readNextForDevices(orgId: string, devs: NextDeviceInput[]): Promise<Map<string, NextResult>> {
  const out = new Map<string, NextResult>();
  const currentOf = (d: NextDeviceInput) => d.desiredDiskId ?? d.mountedDiskId;
  const currentIds = [...new Set(devs.map(currentOf).filter((x): x is string => x !== null))];
  if (currentIds.length === 0) {
    for (const d of devs) out.set(d.id, { kind: 'nothing_mounted' });
    return out;
  }
  const db = getDb();
  const cur = await db.select({ id: disks.id, gameId: disks.gameId }).from(disks)
    .where(and(eq(disks.orgId, orgId), inArray(disks.id, currentIds)));
  const gameOf = new Map(cur.map((r) => [r.id, r.gameId]));
  const gameIds = [...new Set(cur.map((r) => r.gameId))];
  const rows = gameIds.length === 0 ? [] : await db.select({
    id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo,
    sha256: disks.sha256, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes,
    maxTrackBits: disks.maxTrackBits,
  }).from(disks).where(and(eq(disks.orgId, orgId), inArray(disks.gameId, gameIds)));
  for (const d of devs) {
    const c = currentOf(d);
    const g = c ? gameOf.get(c) : undefined;
    out.set(d.id, g ? nextDisk(rows.filter((r) => r.gameId === g), c, d) : { kind: 'nothing_mounted' });
  }
  return out;
}

export type NextInfo = { diskNo: number; diskCount: number; wraps: boolean; preload: 'ready' | 'loading' | null };

/** What the chip and the card show (plan R3). */
export function nextInfo(r: NextResult | undefined, preloadSha256: string | null, preloadState: string | null): NextInfo | null {
  if (!r || r.kind !== 'disk') return null;
  const preload = preloadState === null ? null
    : preloadState === 'ready' && preloadSha256 === r.disk.sha256 ? 'ready' : 'loading';
  return { diskNo: r.disk.diskNo, diskCount: r.diskCount, wraps: r.wraps, preload };
}
```

`disks.maxTrackBits` exists (`src/db/schema/catalog.ts`); `disks` has no timestamp column (plan R5).

- [ ] **Step 4: Run the tests.** `npx vitest run src/lib/next-disk.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/next-disk.ts src/lib/next-disk.test.ts
git commit -m "next-disk: the pure rule and its org-scoped loader"
```

---

### Task 3: Tap with `{action:'next'}`

**Files:**
- Modify: `src/lib/nfc/rules.ts` (`TapOutcome`)
- Modify: `src/lib/nfc/store.ts` (add `tapNext`)
- Modify: `src/app/api/device/tap/route.ts`
- Test: `src/app/api/device/tap/route.test.ts`

**Interfaces:**
- Consumes: `readNextForDevices` (Task 2), `setDesired` (`src/lib/mount.ts`), `decideTap`'s rate rule (`TAP_MIN_INTERVAL_MS`).
- Produces:
  - `TapOutcome` gains `'single' | 'nothing_mounted'`;
  - `tapNext(deviceId, orgId, now): Promise<{ outcome: TapOutcome; diskNo?: number; diskCount?: number; title?: string }>`;
  - the tap route accepts `{ action: 'next' }`.

- [ ] **Step 1: Write failing route tests.** Append to `src/app/api/device/tap/route.test.ts`. Extend the store mock so it also exports `tapNext`: change the `vi.mock('@/lib/nfc/store', …)` line to `vi.mock('@/lib/nfc/store', () => ({ tapDevice, tapNext }));` with, above it:

```ts
const tapNext = vi.fn<
  (deviceId: string, orgId: string, now: Date) => Promise<{ outcome: TapOutcome; diskNo?: number; diskCount?: number }>
>(async () => ({ outcome: 'mounting', diskNo: 2, diskCount: 3 }));
```

and the tests:

```ts
describe('POST /api/device/tap {action:"next"}', () => {
  it('advances through the store with the token org', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ action: 'next', orgId: 'org-EVIL' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'mounting', diskNo: 2, diskCount: 3 });
    expect(tapNext).toHaveBeenCalledWith('dev-1', 'org-1', expect.any(Date));
    expect(tapDevice).not.toHaveBeenCalled();
  });
  it('answers single and nothing_mounted as 200 outcomes', async () => {
    const { POST } = await import('./route');
    tapNext.mockResolvedValueOnce({ outcome: 'single' });
    expect(await (await POST(post({ action: 'next' }))).json()).toEqual({ outcome: 'single' });
    tapNext.mockResolvedValueOnce({ outcome: 'nothing_mounted' });
    expect(await (await POST(post({ action: 'next' }))).json()).toEqual({ outcome: 'nothing_mounted' });
  });
  it.each([{ action: 'prev' }, { action: 'next', diskId: ID }])('refuses %j with 400', async (body) => {
    const { POST } = await import('./route');
    expect((await POST(post(body))).status).toBe(400);
    expect(tapNext).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/app/api/device/tap/route.test.ts`. Expected: the new tests FAIL (400 or tapNext not called).

- [ ] **Step 3: Extend `TapOutcome`** in `src/lib/nfc/rules.ts`:

```ts
export type TapOutcome = 'mounting' | 'already' | 'not_found' | 'too_long' | 'ignored' | 'single' | 'nothing_mounted';
```

- [ ] **Step 4: Add `tapNext`** to `src/lib/nfc/store.ts`. Add `import { readNextForDevices } from '@/lib/next-disk';` at the top, then:

```ts
/**
 * The Next-disk card (multi-disk spec §3.1): the same guard and the same
 * mount step as a disk tap, with the disk chosen by nextDisk. The card
 * carries no disk and no org -- the board's own token bounds it.
 */
export async function tapNext(
  deviceId: string, orgId: string, now: Date,
): Promise<{ outcome: TapOutcome; diskNo?: number; diskCount?: number; title?: string }> {
  const db = getDb();
  const [row] = await db.select({
    desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId, lastTapAt: devices.lastTapAt,
    trackMaxBytes: devices.trackMaxBytes, playsHd: devices.playsHd,
  }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!row) return { outcome: 'not_found' };
  // The burst rule only: 'already' cannot happen, since next is never the current disk.
  if (decideTap({ desiredDiskId: null, lastTapAt: row.lastTapAt }, '', now) === 'ignored') return { outcome: 'ignored' };

  const next = (await readNextForDevices(orgId, [{ id: deviceId, ...row }])).get(deviceId)!;
  let outcome: TapOutcome;
  let extra: { diskNo?: number; diskCount?: number; title?: string } = {};
  if (next.kind !== 'disk') {
    outcome = next.kind;
  } else {
    const r = await setDesired(orgId, deviceId, next.disk.id);
    outcome = r.ok ? 'mounting' : tapRefusalOutcome(r.reason);
    if (r.ok) {
      const [t] = await db.select({ title: games.title }).from(disks)
        .innerJoin(games, eq(games.id, disks.gameId))
        .where(and(eq(disks.id, next.disk.id), eq(disks.orgId, orgId))).limit(1);
      extra = { diskNo: next.disk.diskNo, diskCount: next.diskCount, ...(t ? { title: t.title } : {}) };
    }
  }
  await db.update(devices).set({ lastTapAt: now, lastTapOutcome: outcome })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));
  return { outcome, ...extra };
}
```

- [ ] **Step 5: Accept the action in the route.** In `src/app/api/device/tap/route.ts`, replace the `body` schema and the store call:

```ts
import { tapDevice, tapNext } from '@/lib/nfc/store';
// ...
const body = z.union([
  z.object({ diskId: z.string().regex(DISK_ID_RE) }).strict(),
  z.object({ action: z.literal('next') }).strict(),
]);
// ... after parsing:
  const result = 'action' in parsed.data
    ? await tapNext(device.deviceId, device.orgId, new Date())
    : await tapDevice(device.deviceId, device.orgId, parsed.data.diskId, new Date());
  return Response.json(result, { headers: NO_STORE });
```

`.strict()` is what makes `{action:'next', diskId}` a 400. Check that the existing test which sends `{ diskId: ID, orgId: 'org-EVIL' }` still passes. If `.strict()` rejects the extra `orgId`, use `.strip()` on the diskId branch and instead refuse a body with both keys explicitly: `if (raw && typeof raw === 'object' && 'action' in raw && 'diskId' in raw) return 400`.

- [ ] **Step 6: Run the tests.** `npx vitest run src/app/api/device/tap src/lib/nfc`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/nfc/rules.ts src/lib/nfc/store.ts src/app/api/device/tap/route.ts src/app/api/device/tap/route.test.ts
git commit -m "tap: {action:'next'} advances to the next disk of the mounted title"
```

---

### Task 4: Web action `POST /api/devices/[id]/next`

**Files:**
- Create: `src/app/api/devices/[id]/next/route.ts`
- Test: `src/app/api/devices/[id]/next/route.test.ts`
- Modify: `src/components/devices/device-actions.ts` (add `requestNextDisk`)

**Interfaces:**
- Consumes: `readNextForDevices` (Task 2), `setDesired`, `requireOrg`.
- Produces:
  - `POST /api/devices/[id]/next` → `200 {outcome:'mounting', diskNo, diskCount} | 200 {outcome:'single'|'nothing_mounted'} | 404 {error:'not_found'} | 409 {error:'track_too_long'|'hd_unsupported'}`;
  - `requestNextDisk(deviceId): Promise<boolean>` (client).

- [ ] **Step 1: Write the failing test** `src/app/api/devices/[id]/next/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'org-1' }) }));
const devRow = vi.fn();
vi.mock('@/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => devRow() }) }) }) }),
}));
const readNextForDevices = vi.fn();
vi.mock('@/lib/next-disk', () => ({ readNextForDevices: (...a: unknown[]) => readNextForDevices(...a) }));
const setDesired = vi.fn();
vi.mock('@/lib/mount', () => ({ setDesired: (...a: unknown[]) => setDesired(...a) }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://t/api/devices/x/next', { method: 'POST' });
const D2 = { id: 'disk-2', diskNo: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  devRow.mockReturnValue([{ id: 'dev-1', desiredDiskId: 'disk-1', mountedDiskId: 'disk-1', trackMaxBytes: 14336, playsHd: true }]);
  readNextForDevices.mockResolvedValue(new Map([['dev-1', { kind: 'disk', disk: D2, diskCount: 3, wraps: false }]]));
  setDesired.mockResolvedValue({ ok: true, version: 7 });
});

describe('POST /api/devices/[id]/next', () => {
  it('mounts the next disk with the session org', async () => {
    const { POST } = await import('./route');
    const res = await POST(req(), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'mounting', diskNo: 2, diskCount: 3 });
    expect(setDesired).toHaveBeenCalledWith('org-1', 'dev-1', 'disk-2');
    expect(readNextForDevices.mock.calls[0][0]).toBe('org-1');
  });
  it('is 404 for a board that is not this org\'s', async () => {
    devRow.mockReturnValue([]);
    const { POST } = await import('./route');
    expect((await POST(req(), ctx('dev-9'))).status).toBe(404);
    expect(setDesired).not.toHaveBeenCalled();
  });
  it('answers single without mounting anything', async () => {
    readNextForDevices.mockResolvedValue(new Map([['dev-1', { kind: 'single' }]]));
    const { POST } = await import('./route');
    expect(await (await POST(req(), ctx('dev-1'))).json()).toEqual({ outcome: 'single' });
    expect(setDesired).not.toHaveBeenCalled();
  });
  it('passes a refusal through as 409', async () => {
    setDesired.mockResolvedValue({ ok: false, reason: 'hd_unsupported' });
    const { POST } = await import('./route');
    const res = await POST(req(), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('hd_unsupported');
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `npx vitest run 'src/app/api/devices/\[id\]/next'`. Expected: FAIL, the route module is not found.

- [ ] **Step 3: Implement the route.** Read `node_modules/next/dist/docs/` for route-handler params first. The existing `mount/route.ts` pattern, `ctx.params` as a Promise, is the one to copy.

```ts
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { requireOrg } from '@/lib/session';
import { setDesired } from '@/lib/mount';
import { readNextForDevices } from '@/lib/next-disk';
import { TRACK_TOO_LONG } from '@/lib/hfe/messages';
import { HD_UNSUPPORTED } from '@/lib/hd-messages';

export const maxDuration = 60;

/**
 * The drive menu's "Next disk" (multi-disk spec §3.2): the same rule and the
 * same mount step as the Next-disk card. CSRF: as the mount route (SameSite=Lax).
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;
  const [dev] = await getDb().select({
    id: devices.id, desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId,
    trackMaxBytes: devices.trackMaxBytes, playsHd: devices.playsHd,
  }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!dev) return Response.json({ error: 'not_found' }, { status: 404 });

  const next = (await readNextForDevices(orgId, [dev])).get(dev.id)!;
  if (next.kind !== 'disk') return Response.json({ outcome: next.kind });
  const r = await setDesired(orgId, deviceId, next.disk.id);
  if (!r.ok && r.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (!r.ok && r.reason === 'hd_unsupported') {
    return Response.json({ error: 'hd_unsupported', reason: HD_UNSUPPORTED }, { status: 409 });
  }
  if (!r.ok) return Response.json({ error: 'track_too_long', reason: TRACK_TOO_LONG }, { status: 409 });
  return Response.json({ outcome: 'mounting', diskNo: next.disk.diskNo, diskCount: next.diskCount });
}
```

- [ ] **Step 4: Add the client action** to `src/components/devices/device-actions.ts`, after `requestEject`:

```ts
/** POST /api/devices/[id]/next -- the drive menu's and the card's "Next disk". */
export async function requestNextDisk(deviceId: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`/api/devices/${deviceId}/next`, { method: 'POST' });
  } catch {
    toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    return false;
  }
  const body = await res.json().catch(() => null) as { outcome?: string; diskNo?: number; diskCount?: number; reason?: string } | null;
  if (!res.ok) {
    toast.error('Could not switch disks', { description: body?.reason ?? `The server answered ${res.status}.` });
    return false;
  }
  if (body?.outcome === 'mounting') {
    toast.success(`Switching to disk ${body.diskNo} of ${body.diskCount}`);
    return true;
  }
  toast.message(body?.outcome === 'single' ? 'This title has only one disk' : 'No disk in the drive');
  return false;
}
```

- [ ] **Step 5: Run the tests.** `npx vitest run 'src/app/api/devices/\[id\]/next'`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add 'src/app/api/devices/[id]/next' src/components/devices/device-actions.ts
git commit -m "devices: POST /api/devices/[id]/next and its client action"
```

---

### Task 5: Poll carries `next` (and `nfcWrite.kind`), inside the byte budget

**Files:**
- Modify: `src/app/api/device/poll/route.ts`
- Modify: `src/lib/device-limits.test.ts`
- Test: `src/app/api/device/poll/route.test.ts`

**Interfaces:**
- Consumes:
  - `readNextForDevices` (Task 2);
  - `readDesired`;
  - `nfcWriteForPoll` returning `kind` (Task 6 — do Task 6 BEFORE this one if executing strictly in order; otherwise stub `kind` as `'disk'` here and let Task 6 change it).
- Produces: the poll JSON gains `next: {diskId, sha256, diskNo} | null` whenever `desired` is non-null, placed AFTER `desired`. `nfcWrite` gains `kind: 'next'` only for a live next-card request.

- [ ] **Step 1: Extend the budget test first.** In `src/lib/device-limits.test.ts`, inside the worst-case test, add after `nfcWrite` is built:

```ts
    // Multi-disk plan R1: `next` is minimal -- a real 36-char disk id, a
    // sha256 and a disk number -- because a desired-shaped object would not fit.
    const next =
      `,"next":{"diskId":"${'f'.repeat(36)}"`
      + `,"sha256":"${'a'.repeat(SHA)}"`
      + ',"diskNo":4294967295}';
    const nfcKind = ',"kind":"next"';
```

and change the sum to `Buffer.byteLength(disk + next + update + nfcWrite + nfcKind, 'utf8')`. Update the "comes to 1217 bytes" comment to the new printed figure.

- [ ] **Step 2: Run the budget test.** `npx vitest run src/lib/device-limits.test.ts`. Expected: PASS (about 1,360 against 1,536). If it FAILS, stop: the ruling R1 shape is wrong and needs revisiting, not a bigger buffer (old boards have 1,536 in flash).

- [ ] **Step 3: Write failing poll tests.** In `src/app/api/device/poll/route.test.ts`, follow the file's existing mock style for `@/lib/mount`. Add a mock for `@/lib/next-disk`'s `readNextForDevices` returning `new Map([['dev-1', { kind: 'disk', disk: { id: 'd2', sha256: 'b'.repeat(64), diskNo: 2 }, diskCount: 2, wraps: false }]])`, then tests:
  - with `desired` present, the body has `next: { diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 }`;
  - with `readNextForDevices` giving `{kind:'single'}`, `next` is `null`;
  - with `desired: null`, there is no `next` key at all and `readNextForDevices` is not called;
  - `JSON.stringify(body).indexOf('"next"') > JSON.stringify(body).indexOf('"desired"')` (order).

  `readNextForDevices` needs the device's caps. Extend the `readDesired` result used by the route? Do NOT change readDesired's shape. Instead select `{desiredDiskId, mountedDiskId, trackMaxBytes, playsHd}` inside a new helper `readNextForPoll(deviceId, orgId)` exported from `src/lib/next-disk.ts`:

```ts
export async function readNextForPoll(deviceId: string, orgId: string): Promise<{ diskId: string; sha256: string; diskNo: number } | null> {
  const [dev] = await getDb().select({
    id: devices.id, desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId,
    trackMaxBytes: devices.trackMaxBytes, playsHd: devices.playsHd,
  }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!dev) return null;
  const r = (await readNextForDevices(orgId, [dev])).get(dev.id);
  return r?.kind === 'disk' ? { diskId: r.disk.id, sha256: r.disk.sha256, diskNo: r.disk.diskNo } : null;
}
```

  (add `import { devices } from '@/db/schema/devices';`), and mock THAT in the poll test instead.

- [ ] **Step 4: Run the tests to see them fail.** `npx vitest run src/app/api/device/poll`. Expected: the new tests FAIL.

- [ ] **Step 5: Implement in the route.** In the delivery branch, after `const state = await readDesired(...)`:

```ts
      // Multi-disk spec §3.3 / plan R1: the disk the board should preload.
      // Computed on delivery only (never per tick), and only with a disk desired.
      const next = state.desired ? await readNextForPoll(device.deviceId, device.orgId) : undefined;
```

and in the JSON object, directly after `desired: state.desired,`:

```ts
          ...(next !== undefined ? { next } : {}),
```

In the `nfcWrite` object, after `title`, add `...(nfc.kind === 'next' ? { kind: 'next' } : {}),`. `nfc.kind` comes from Task 6's `nfcWriteForPoll`.

- [ ] **Step 6: Run the tests.** `npx vitest run src/app/api/device/poll src/lib/device-limits.test.ts src/lib/next-disk.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/app/api/device/poll src/lib/device-limits.test.ts src/lib/next-disk.ts
git commit -m "poll: carry the next disk to preload (minimal shape, inside the byte budget)"
```

---

### Task 6: Writing a Next-disk card (server)

**Files:**
- Modify: `src/lib/nfc/rules.ts` (`nfcWriteForPoll`)
- Modify: `src/lib/nfc/store.ts` (`requestNfcWrite`, new `requestNfcNextWrite`, `cancelNfcWrite`, `readNfcWriteRow`)
- Modify: `src/app/api/nfc/write/route.ts`
- Test: `src/lib/nfc/rules.test.ts`, `src/app/api/nfc/write/route.test.ts`

**Interfaces:**
- Produces:
  - `nfcWriteForPoll(row & {nfcWriteKind: string}, ack, now) → {seq, diskId: string|null, kind: 'disk'|'next'} | null`. `kind: 'next'` only for a LIVE next request; a disarm is `{seq, diskId:null, kind:'disk'}`.
  - `requestNfcNextWrite(orgId, deviceId, now): Promise<number | null>`.
  - `POST /api/nfc/write` accepts `{kind:'next', deviceId?}` → `{seq, deviceId, deviceName, title: 'Next-disk card'}`.

- [ ] **Step 1: Write failing rules tests.** Add to `src/lib/nfc/rules.test.ts`:

```ts
describe('nfcWriteForPoll with a Next-disk request', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const live = { nfcWriteSeq: 5, nfcWriteDiskId: null, nfcWriteKind: 'next',
    nfcWriteExpiresAt: new Date(now.getTime() + 60_000), nfcWriteResultSeq: null };
  it('delivers a live next request with kind next and no disk', () => {
    expect(nfcWriteForPoll(live, 4, now)).toEqual({ seq: 5, diskId: null, kind: 'next' });
  });
  it('delivers an expired one as a plain disarm', () => {
    expect(nfcWriteForPoll({ ...live, nfcWriteExpiresAt: new Date(now.getTime() - 1) }, 4, now))
      .toEqual({ seq: 5, diskId: null, kind: 'disk' });
  });
  it('keeps disk requests as they were', () => {
    expect(nfcWriteForPoll({ ...live, nfcWriteKind: 'disk', nfcWriteDiskId: 'x' }, 4, now))
      .toEqual({ seq: 5, diskId: 'x', kind: 'disk' });
  });
});
```

Update the existing `nfcWriteForPoll` test rows to include `nfcWriteKind: 'disk'` and expect `kind: 'disk'` in each non-null result.

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/lib/nfc/rules.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement in `rules.ts`:**

```ts
export function nfcWriteForPoll(
  row: { nfcWriteSeq: number; nfcWriteDiskId: string | null; nfcWriteKind: string;
         nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null },
  ack: number, now: Date,
): { seq: number; diskId: string | null; kind: 'disk' | 'next' } | null {
  if (row.nfcWriteSeq <= ack) return null;
  const next = row.nfcWriteKind === 'next';
  const live = (next || row.nfcWriteDiskId !== null)
    && row.nfcWriteExpiresAt !== null && now.getTime() <= row.nfcWriteExpiresAt.getTime()
    && row.nfcWriteResultSeq !== row.nfcWriteSeq;
  if (!live) return { seq: row.nfcWriteSeq, diskId: null, kind: 'disk' };
  return next ? { seq: row.nfcWriteSeq, diskId: null, kind: 'next' } : { seq: row.nfcWriteSeq, diskId: row.nfcWriteDiskId, kind: 'disk' };
}
```

- [ ] **Step 4: Store changes** in `src/lib/nfc/store.ts`:
  - In `readNfcWriteRow`'s select, add `nfcWriteKind: devices.nfcWriteKind,`.
  - In `requestNfcWrite`'s `.set({...})`, add `nfcWriteKind: 'disk',`.
  - In `cancelNfcWrite`'s `.set({...})`, add `nfcWriteKind: 'disk',`. This is Review Focus 3.
  - Add:

```ts
/** Arms the universal Next-disk card (multi-disk spec §3.4): no disk, kind 'next'. */
export async function requestNfcNextWrite(orgId: string, deviceId: string, now: Date): Promise<number | null> {
  const [r] = await getDb().update(devices).set({
    nfcWriteSeq: sql`${devices.nfcWriteSeq} + 1`, nfcWriteDiskId: null, nfcWriteKind: 'next',
    nfcWriteExpiresAt: new Date(now.getTime() + NFC_WRITE_TTL_MS),
    nfcWriteResultSeq: null, nfcWriteResult: null, nfcWriteResultUid: null,
  }).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).returning({ seq: devices.nfcWriteSeq });
  return r?.seq ?? null;
}
```

- [ ] **Step 5: Route.** In `src/app/api/nfc/write/route.ts`, make `postBody` a union:

```ts
const postBody = z.union([
  z.object({ diskId: z.string().regex(DISK_ID_RE), deviceId: z.string().min(1).max(64).optional() }),
  z.object({ kind: z.literal('next'), deviceId: z.string().min(1).max(64).optional() }),
]);
```

In `POST`, after `const { device } = choice;`:

```ts
  if ('kind' in parsed.data) {
    const seq = await requestNfcNextWrite(orgId, device.id, new Date());
    if (seq === null) return notFound();
    return Response.json({ seq, deviceId: device.id, deviceName: device.name, title: 'Next-disk card' }, { headers: NO_STORE });
  }
  const { diskId } = parsed.data;
```

and take `deviceId` from `parsed.data.deviceId` for `chooseNfcDevice`. Add a route test: `{kind:'next'}` with one reader-present device → 200 with `title: 'Next-disk card'` and `requestNfcNextWrite` called with `('org-1', <deviceId>, any Date)`. Follow the file's existing mocks.

- [ ] **Step 6: Run.** `npx vitest run src/lib/nfc src/app/api/nfc`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/nfc src/app/api/nfc
git commit -m "nfc: arm a Next-disk card write; a cancel resets the kind"
```

---

### Task 7: Status report carries `preload`

**Files:**
- Modify: `src/app/api/device/status/route.ts`
- Modify: `src/lib/mount.ts` (`recordStatus`)
- Test: `src/app/api/device/status/route.test.ts` (follow its mocks)

**Interfaces:**
- Produces:
  - status body `preload?: {sha256, state:'loading'|'ready'} | null`;
  - `recordStatus(…, { preload?: {sha256:string; state:'loading'|'ready'} | null })`.
  - Storage:
    - an object → both columns;
    - `null` → `preloadSha256 = null, preloadState = 'none'`;
    - absent with `firmwareVersion` present → both NULL (a build that does not know the field, the trackMaxBytes rule);
    - absent without it → untouched.

- [ ] **Step 1: Failing tests.** In the status route test, assert that `recordStatus` receives:
  - `preload: { sha256: 'a'.repeat(64), state: 'ready' }` for that body;
  - `preload: null` for `"preload":null`;
  - `preload: undefined` for a malformed `{"preload":{"sha256":"x"}}` (dropped via `.catch(undefined)`, never a 400).

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/app/api/device/status`.

- [ ] **Step 3: Implement.** In the status schema:

```ts
  // Multi-disk spec §3.5: what the idle slot holds. Telemetry -- dropped, never rejected.
  preload: z.object({ sha256: z.string().regex(SHA256_RE), state: z.enum(['loading', 'ready']) })
    .nullable().optional().catch(undefined),
```

and pass `preload: parsed.data.preload` to `recordStatus`. In `recordStatus`'s parameter type, add `preload?: { sha256: string; state: 'loading' | 'ready' } | null;`. In the body, next to the playsHd rule:

```ts
  // Build-bound like trackMaxBytes: a report naming its firmware but silent on
  // preload is a build without the field, and must not keep a newer build's claim.
  if (s.preload !== undefined) {
    patch.preloadSha256 = s.preload?.sha256 ?? null;
    patch.preloadState = s.preload ? s.preload.state : 'none';
  } else if (s.firmwareVersion !== undefined) {
    patch.preloadSha256 = null;
    patch.preloadState = null;
  }
```

- [ ] **Step 4: Run.** `npx vitest run src/app/api/device/status src/lib`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/device/status src/lib/mount.ts
git commit -m "status: record the board's preload slot"
```

---

### Task 8: "Next disk" in the drive menu and on the device card

**Files:**
- Modify: `src/lib/live-state.ts` (`LiveStateRow`, `liveStateRows`, `liveFingerprint`)
- Modify: `src/lib/drive-chips.ts` (`DriveChip.next`)
- Modify: `src/components/shell/drive-chips.tsx` (`DriveEntry`)
- Modify: `src/lib/queries.ts` (`DeviceListItem`, `listDevices`)
- Modify: `src/app/(app)/devices/page.tsx`, `src/components/devices/device-list.tsx`, `src/components/devices/device-card.tsx`
- Test: `src/lib/live-state.test.ts`, `src/lib/drive-chips.test.ts`

**Interfaces:**
- Consumes: `readNextForDevices`, `nextInfo`, `NextInfo` (Task 2); `requestNextDisk` (Task 4).
- Produces:
  - `LiveStateRow` gains `trackMaxBytes: number|null; playsHd: boolean; preloadSha256: string|null; preloadState: string|null; next: NextInfo | null`;
  - `DriveChip` gains `next: NextInfo | null` (set only when `phase === 'loaded'`);
  - `DeviceListItem` gains the same four columns;
  - `DeviceCard` takes `next?: NextInfo | null`.

- [ ] **Step 1: Failing unit tests.**
  - `src/lib/drive-chips.test.ts`, using the file's existing row factory:
    - a loaded row with `next: {diskNo:3, diskCount:4, wraps:false, preload:'ready'}` gives `chip.next` equal to it;
    - the same row in phase `loading` gives `chip.next === null`.
  - `src/lib/live-state.test.ts`: two rows identical except `next.preload` (`'loading'` vs `'ready'`) give DIFFERENT fingerprints, and likewise two that differ only in `next.diskNo`.

- [ ] **Step 2: Run to see them fail.** `npx vitest run src/lib/drive-chips.test.ts src/lib/live-state.test.ts`.

- [ ] **Step 3: live-state.**
  - Add the fields to `LiveStateRow`.
  - In `liveStateRows`' select, add `trackMaxBytes: devices.trackMaxBytes, playsHd: devices.playsHd, preloadSha256: devices.preloadSha256, preloadState: devices.preloadState`.
  - Turn the function body into:

```ts
  const rows = await db.select({ /* ...existing + the four above... */ }) /* ...joins as before... */;
  const nexts = await readNextForDevices(orgId, rows);
  return rows.map((r) => ({ ...r, next: nextInfo(nexts.get(r.id), r.preloadSha256, r.preloadState) }));
```

  `readNextForDevices` uses `getDb()` itself. `liveStateRows` receives `db` as a parameter, so keep that parameter for its own query. In `liveFingerprint`'s line array, before the online flag, add:

```ts
        r.next ? `${r.next.diskNo}/${r.next.diskCount}/${r.next.wraps ? 1 : 0}/${r.next.preload ?? ''}` : '',
```

- [ ] **Step 4: drive-chips model.** In `DriveChip` add `next: NextInfo | null;` (import the type from `@/lib/next-disk`, type-only). In `toDriveChip`'s return, add `next: phase === 'loaded' ? r.next : null,`.

- [ ] **Step 5: Drive menu.** In `DriveEntry` (`src/components/shell/drive-chips.tsx`), import `requestNextDisk` next to `requestEject`. Between the protect item and the separator before Eject, add:

```tsx
      {chip.next && (
        <>
          <DropdownMenuItem
            data-testid={`drive-next-${chip.id}`}
            className={ITEM_CLASS}
            onClick={async () => { if (await requestNextDisk(chip.id)) start(() => router.refresh()); }}
          >
            <span className="flex-1">
              Next disk: Disk {chip.next.diskNo} of {chip.next.diskCount}{chip.next.wraps ? ' (wraps)' : ''}
            </span>
          </DropdownMenuItem>
          {chip.next.preload && (
            <DropdownMenuLabel className="px-2 pb-1 text-[11px]" style={{ color: 'var(--muted)' }}
                               data-testid={`drive-preload-${chip.id}`} data-preload={chip.next.preload}>
              {chip.next.preload === 'ready'
                ? `Disk ${chip.next.diskNo} ready (instant swap)`
                : `Disk ${chip.next.diskNo} loading…`}
            </DropdownMenuLabel>
          )}
        </>
      )}
```

- [ ] **Step 6: Devices page and card.**
  - `listDevices` (`src/lib/queries.ts`): add `trackMaxBytes`, `playsHd`, `preloadSha256` and `preloadState` to the select and to `DeviceListItem`.
  - `devices/page.tsx`: after loading `devices`, compute `const nexts = await readNextForDevices(orgId, devices);` and pass `nextById={Object.fromEntries(devices.map((d) => [d.id, nextInfo(nexts.get(d.id), d.preloadSha256, d.preloadState)]))}` to `DeviceList`.
  - `DeviceList`: thread `nextById[d.id]` to each `DeviceCard` as `next`.
  - `DeviceCard`: in the bottom row, left of `EjectButton`, render when `next && state === 'converged'` a client `NextDiskButton` (new small file `src/components/devices/next-disk-button.tsx`, the shape of `eject-button.tsx`, calling `requestNextDisk`, `data-testid={\`next-disk-${deviceId}\`}`, label `Next: disk ${next.diskNo}`). Also render the preload line under `subText` when `next?.preload`:

```tsx
        {next?.preload && (
          <span className="text-[11px]" style={{ color: 'var(--muted)' }} data-testid={`device-preload-${device.id}`}
                data-preload={next.preload}>
            {next.preload === 'ready' ? `Disk ${next.diskNo} ready (instant swap)` : `Disk ${next.diskNo} loading…`}
          </span>
        )}
```

- [ ] **Step 7: Run the unit tests, typecheck and lint.** `npx vitest run src/lib && npx tsc --noEmit -p . && npx eslint src/lib/live-state.ts src/lib/drive-chips.ts src/components/shell/drive-chips.tsx src/components/devices src/app/\(app\)/devices`. Expected: PASS, no output.

- [ ] **Step 8: Commit.**

```bash
git add src/lib/live-state.ts src/lib/live-state.test.ts src/lib/drive-chips.ts src/lib/drive-chips.test.ts src/components/shell/drive-chips.tsx src/lib/queries.ts 'src/app/(app)/devices/page.tsx' src/components/devices
git commit -m "web: Next disk in the drive menu and on the device card, with the preload line"
```

---

### Task 9: "Write a Next-disk card" on the Devices page

**Files:**
- Modify: `src/components/nfc/fob-button.tsx`
- Modify: `src/app/(app)/devices/page.tsx`

**Interfaces:**
- Consumes: `POST /api/nfc/write {kind:'next', deviceId}` (Task 6), `listNfcReaders(orgId)`.
- Produces: `FobButton` prop `mode?: 'disk' | 'next'` (default `'disk'`). In `'next'` mode:
  - the trigger is a labelled pill button, `data-testid="write-next-card"`;
  - the disk choice is skipped;
  - the POST body is `{kind:'next', deviceId}`;
  - the heading reads "Next-disk card";
  - the explanation line reads "This card switches whatever is mounted to its next disk.".

- [ ] **Step 1: FobButton changes.**
  - Add `mode = 'disk'` to the destructured props and to the prop type.
  - Change `start(disk: string, device: string)` to `start(disk: string | null, device: string)`, with the body `JSON.stringify(disk ? { diskId: disk, deviceId: device } : { kind: 'next', deviceId: device })`.
  - In `onOpen`: `const onlyDisk = mode === 'next' ? null : (disks.length === 1 ? disks[0].id : null);`, and auto-start when `(mode === 'next' || onlyDisk) && onlyDevice`.
  - In the choose phase, the Start button is enabled when `(mode === 'next' || diskId) && deviceId`, and calls `start(mode === 'next' ? null : diskId, deviceId)`.
  - Heading: `const heading = mode === 'next' ? 'Next-disk card' : (…existing…)`. Directly under it, when `mode === 'next'`: `<p className="text-[12px]" style={{ color: 'var(--muted)' }}>This card switches whatever is mounted to its next disk.</p>`.
  - Trigger: when `mode === 'next'`, render instead:

```tsx
    <button type="button" data-testid="write-next-card" onClick={onOpen}
            className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold"
            style={{ background: 'var(--on-dark)', color: '#16273a' }}>
      <Nfc size={14} strokeWidth={1.75} aria-hidden /> Write a Next-disk card
    </button>
```

- [ ] **Step 2: Devices page.** Load `listNfcReaders(orgId)` alongside the other reads, and set `actions={<div className="flex items-center gap-2">{readers.length > 0 && <FobButton mode="next" testId="write-next-card" title="Next-disk card" disks={[]} devices={readers} />}<PairButton /></div>}`.

- [ ] **Step 3: Typecheck and lint.** `npx tsc --noEmit -p . && npx eslint src/components/nfc/fob-button.tsx 'src/app/(app)/devices/page.tsx'`. Expected: no output.

- [ ] **Step 4: Commit.**

```bash
git add src/components/nfc/fob-button.tsx 'src/app/(app)/devices/page.tsx'
git commit -m "devices: Write a Next-disk card (the fob dialog in next mode)"
```

---

### Task 10: Firmware — WFDK v2 tag and the reader's Next event

**Files:**
- Modify: `wifi-floppy/firmware/src/nfc_tag.h`, `nfc_tag.c`
- Modify: `wifi-floppy/firmware/src/nfc_reader.h`, `nfc_reader.c`
- Test: `wifi-floppy/firmware/test/test_nfc_tag.c`, `test/test_nfc_reader.c`

**Interfaces:**
- Produces:
  - `NFC_TAG_NEXT` (a new `nfc_tag_result_t`);
  - `bool nfc_tag_encode_next(uint8_t out[NFC_TAG_BYTES]);`
  - `NFC_EV_TAG_NEXT` (a new `nfc_ev_kind_t`, appended at the END of the enum so existing values keep their numbers);
  - `void nfc_arm_write_next(nfc_reader_t *r, uint32_t seq);`

- [ ] **Step 1: Failing tag tests.** Add to `test/test_nfc_tag.c`, in its existing style (read the file's harness macros first):

```c
static void test_next_card_round_trips(void) {
    uint8_t buf[NFC_TAG_BYTES];
    char id[NFC_DISK_ID_LEN + 1];
    CHECK(nfc_tag_encode_next(buf));
    CHECK(memcmp(buf, "WFDK", 4) == 0);
    CHECK(buf[4] == 2 && buf[5] == 4 && memcmp(buf + 6, "next", 4) == 0);
    CHECK(nfc_tag_decode(buf, id) == NFC_TAG_NEXT);
}
static void test_next_card_crc_is_checked(void) {
    uint8_t buf[NFC_TAG_BYTES];
    char id[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode_next(buf);
    buf[7] ^= 1;
    CHECK(nfc_tag_decode(buf, id) == NFC_TAG_BAD_DATA);
}
static void test_v2_with_other_payload_is_bad(void) {
    uint8_t buf[NFC_TAG_BYTES];
    char id[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode_next(buf);
    memcpy(buf + 6, "prev", 4);
    uint16_t crc = nfc_crc16(buf, 42); buf[42] = crc >> 8; buf[43] = (uint8_t)crc;
    CHECK(nfc_tag_decode(buf, id) == NFC_TAG_BAD_DATA);
}
```

Register them in the file's test list. Existing v1 tests must remain unchanged.

- [ ] **Step 2: Run to see them fail.** `wifi-floppy/firmware/test/run.sh 2>&1 | tail -20`. Expected: compile failure on `nfc_tag_encode_next`.

- [ ] **Step 3: Implement.** In `nfc_tag.h`, add `NFC_TAG_NEXT,   // a WFDK v2 "next" card (multi-disk spec §4.1)` to the enum and declare `bool nfc_tag_encode_next(uint8_t out[NFC_TAG_BYTES]);`. In `nfc_tag.c`:

```c
bool nfc_tag_encode_next(uint8_t out[NFC_TAG_BYTES]) {
    memset(out, 0, NFC_TAG_BYTES);
    memcpy(out, "WFDK", 4);
    out[4] = 2;
    out[5] = 4;
    memcpy(out + 6, "next", 4);
    uint16_t crc = nfc_crc16(out, NFC_CONTENT_BYTES);
    out[42] = (uint8_t)(crc >> 8);
    out[43] = (uint8_t)crc;
    return true;
}
```

In `nfc_tag_decode`, replace step 2 with:

```c
    // 2. Our marker, but a version/length we don't understand. v2 is the
    //    action card: only "next" exists, and older firmware reads it as
    //    BAD_DATA -- the safe failure (multi-disk spec §4.1).
    bool v1 = in[4] == 1 && in[5] == NFC_DISK_ID_LEN;
    bool v2 = in[4] == 2 && in[5] == 4;
    if (!v1 && !v2) return NFC_TAG_BAD_DATA;
```

After the CRC check (step 3), before the disk-id path:

```c
    if (v2) return memcmp(in + 6, "next", 4) == 0 ? NFC_TAG_NEXT : NFC_TAG_BAD_DATA;
```

- [ ] **Step 4: Reader.** Read `nfc_reader.c` around its `nfc_tag_decode` call and `nfc_arm_write`.
  - Where decode returns `NFC_TAG_OK` and the reader emits `NFC_EV_TAG_READ`, add the `NFC_TAG_NEXT` case emitting `NFC_EV_TAG_NEXT` with an empty `disk_id`, through the same presence/3 s-absence gating. Append `NFC_EV_TAG_NEXT` at the END of `nfc_ev_kind_t`.
  - Add `nfc_arm_write_next(r, seq)`: identical to `nfc_arm_write` except that the payload comes from `nfc_tag_encode_next(r->arm_payload)` and `arm_bad = false`.
  - In `test/test_nfc_reader.c` (against `si512_fake`), add:
    - a v2 tag placed on the fake yields exactly one `NFC_EV_TAG_NEXT`, and none while it stays on;
    - after `nfc_arm_write_next`, the next tag arrival is written with the v2 payload (read back from the fake's blocks 4–6) and a `NFC_EV_WRITE_DONE ok` event follows.

- [ ] **Step 5: Run.** `wifi-floppy/firmware/test/run.sh 2>&1 | tail -5`. Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add wifi-floppy/firmware/src/nfc_tag.h wifi-floppy/firmware/src/nfc_tag.c wifi-floppy/firmware/src/nfc_reader.h wifi-floppy/firmware/src/nfc_reader.c wifi-floppy/firmware/test/test_nfc_tag.c wifi-floppy/firmware/test/test_nfc_reader.c
git commit -m "firmware: WFDK v2 Next-disk card -- decode, event, arm-and-write"
```

---

### Task 11: Firmware — device client: `next`, preload, swap, tap, status

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h`, `device_client.c`
- Test: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Consumes: Task 5's poll `next` object and `nfcWrite.kind`; Task 7's status `preload`; Task 3's tap `{action:"next"}` response `{outcome, diskNo, diskCount, title}`.
- Produces (in `device_client.h`):

```c
// Multi-disk spec §4.3. What the idle slot holds.
typedef struct {
    bool     known;              // a `next` came with the last delivered poll
    char     next_sha256[65];    // what the server says comes next ("" = none)
    char     next_disk_id[37];
    uint32_t next_disk_no;
    int      slot;               // SLOT_NONE = nothing preloaded
    char     sha256[65];         // what `slot` holds, verified
    bool     loading;            // a preload fetch is in progress
} dc_preload_t;
// In device_client_t:  dc_preload_t preload;  bool (*_preload_ok)(void *ctx); void *_preload_ok_ctx;
//                      bool nfc_write_next;   // the armed write is the Next-disk card
void dc_set_preload_gate(device_client_t *c, bool (*fn)(void *ctx), void *ctx);
// Fetches `next` into the inactive slot WITHOUT publishing it, if the gate
// allows and it is not already there. Returns true if it did any work.
bool dc_preload_step(device_client_t *c);
typedef enum { /* existing... */ DC_TAP_SINGLE, DC_TAP_NO_DISK } /* appended to dc_tap_outcome_t */;
dc_tap_outcome_t dc_tap_next(device_client_t *c, uint32_t *disk_no, uint32_t *disk_count,
                             char *title_out, int title_cap);
```

- [ ] **Step 1: Failing tests** in `test/test_device_client.c`, using the file's fake transport and fixture images (read how existing fetch tests serve `/api/device/image/<sha>`). Write each as a separate test function:
  1. **next_is_lifted_before_desired_is_read** (Review Focus 1): poll body `{"version":2,"next":{"diskId":"<id2>","sha256":"<B>","diskNo":2},"desired":{"sha256":"<A>",...}}`. After `dc_step`, the image request path contains `<A>`, never `<B>`, and `c.preload.next_sha256` is `<B>`.
  2. **preload_fetches_next_into_inactive_without_publishing**: after mounting A, with `next` = B and the gate returning true, `dc_preload_step` requests `/api/device/image/<B>`. Afterwards `psram_active_slot()` is unchanged, `c.preload.slot == psram_inactive_slot()` and `c.preload.sha256 == B`.
  3. **no_preload_while_gate_false** (Review Focus 2): the gate returns false, and `dc_preload_step` returns false with no request made.
  4. **no_refetch_when_already_preloaded**: a second `dc_preload_step` makes no request.
  5. **swap_publishes_preloaded_slot_without_fetching**: a poll with desired = B publishes `c.preload.slot` with no image request, `mounted_sha256 == B`, and the preload is cleared (`slot == SLOT_NONE`).
  6. **swap_with_mismatched_preload_fetches** (R2): preload holds B, desired = C, so there is an image request for C and the preload is cleared.
  7. **regular_fetch_invalidates_preload** (Review Focus 2): preload holds B, a poll desires C and fetches, and afterwards `c.preload.slot == SLOT_NONE`.
  8. **next_null_drops_preload**: a poll with `"next":null` clears the preload record.
  9. **held_swap_waits** (spec §4.2): the hold predicate is true, a desired B with preload B does not publish; after the hold goes false, the next `dc_step` publishes from preload.
  10. **tap_next_parses_outcome**: `dc_tap_next` posts exactly `{"action":"next"}` and maps `mounting` (with diskNo 2, diskCount 3, title), `single` → `DC_TAP_SINGLE` and `nothing_mounted` → `DC_TAP_NO_DISK`.
  11. **nfc_write_kind_next_arms_next**: a poll with `"nfcWrite":{"seq":3,"diskId":null,"title":null,"kind":"next"}` sets `nfc_write_new`, `nfc_write_next == true` and `nfc_write_disk_id == ""`. Without `kind` it is a disarm (`nfc_write_next == false`).
  12. **status_reports_preload**: with preload ready (B), the status body contains `"preload":{"sha256":"<B>","state":"ready"}`; while loading, `"state":"loading"`; with none, `"preload":null`. `test_status_body_fits_at_maximum` must include the ready form. If it then fails, raise `DC_STATUS_BODY_BYTES` to 1280 and `DC_STATUS_REQ_BYTES` to 1792 (both are static buffers), and say so in the commit message.

- [ ] **Step 2: Run to see them fail.** `wifi-floppy/firmware/test/run.sh 2>&1 | tail -30`.

- [ ] **Step 3: Implement.**
  - **Lift `next`:** a `dc_take_next(c, json)` called in `dc_step` next to `dc_take_fw_fields`/`dc_take_nfc_write`, BEFORE `dc_handle_poll_body`. It uses `json_object(json, "next", obj, sizeof obj, true)` (which blanks it). On success, it parses `sha256`/`diskId`/`diskNo` into `c->preload.next_*` and sets `known = true`. For `"next":null`, it clears `next_sha256` and, if the preload record holds anything, drops it (`slot = SLOT_NONE`, `sha256 = ""`). When absent, it changes nothing.
  - **Split `dc_fetch_image`** into `static bool dc_fetch_into(device_client_t *c, const char *sha256, int target)`, which does the request, streaming and `image_parse_end` and returns success, keeping every existing log and block/backoff branch in the caller. `dc_fetch_image` calls it and then does the publish/transition exactly as today. At its START, `dc_fetch_image` sets `c->preload.slot = SLOT_NONE; c->preload.sha256[0] = '\0';` because it is about to overwrite the inactive slot (Review Focus 2).
  - **Swap from preload:** in `dc_handle_poll_body`, after the `dc_held` check and before `return dc_fetch_image(c, &d);`:

```c
    if (c->preload.slot != SLOT_NONE && c->preload.slot == psram_inactive_slot()
        && strcmp(c->preload.sha256, d.sha256) == 0) {
        wf_logf(WF_INFO, "swap: %.12s from preloaded slot %d", d.sha256, c->preload.slot);
        c->state = DC_SWAPPING;
        psram_publish_slot(c->preload.slot);
        c->preload.slot = SLOT_NONE;
        c->preload.sha256[0] = '\0';
        dc_complete_transition(c, d.version, d.sha256, d.disk_id, d.write_protected);
        dc_emit(c, DC_OBS_MOUNTED, 0, 0);
        c->state = DC_IDLE_POLL;
        dc_backoff_reset(c);
        return c->state;
    }
```

  - **`dc_preload_step`:** returns false unless all of these hold:
    - `c->state == DC_IDLE_POLL`;
    - `next_sha256[0]`;
    - `strcmp(next_sha256, mounted_sha256) != 0`;
    - `strcmp(preload.sha256, next_sha256) != 0`;
    - the digest is not blocked;
    - `c->_preload_ok && c->_preload_ok(ctx)`.

    It then sets `loading = true`, emits nothing to the OLED, and calls `dc_fetch_into(c, next_sha256, psram_inactive_slot())`. On success it records `slot`/`sha256`; on any failure it leaves `slot = SLOT_NONE` and calls `dc_enter_backoff(c)`. Either way it ends with `loading = false`. A 400/404/422 blocks the digest exactly as a fetch does.
  - **`dc_tap_next`:** the same as `dc_tap`, with body `{"action":"next"}` and resp `static char resp[256]`. It maps `single`/`nothing_mounted` and reads `diskNo`/`diskCount` with `json_u32`, `title` with `json_str`.
  - **`nfcWrite.kind`:** in `dc_take_nfc_write`, read `kind` into `char kind[8]` and set `c->nfc_write_next = strcmp(kind, "next") == 0 && id[0] == '\0';`.
  - **Status:** in `dc_report_status`, append `,"preload":{"sha256":"%s","state":"%s"}` when `loading || slot != SLOT_NONE`: state `loading` while loading (sha = `next_sha256`), else `ready` (sha = `preload.sha256`). Otherwise append `,"preload":null`.
  - `dc_init` sets `c->preload.slot = SLOT_NONE`.

- [ ] **Step 4: Run.** `wifi-floppy/firmware/test/run.sh 2>&1 | tail -5`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/test/test_device_client.c
git commit -m "firmware: preload the next disk into the idle slot; swap from it; tap next"
```

---

### Task 12: Firmware — wiring in main.c, OLED lines, version 1.6.0

**Files:**
- Modify: `wifi-floppy/firmware/src/nfc_ui.h`, `nfc_ui.c`, `main.c`, `CMakeLists.txt`
- Test: `wifi-floppy/firmware/test/test_nfc_ui.c`

**Interfaces:**
- Consumes: Tasks 10–11.
- Produces: `const char *nfc_ui_next_line(dc_tap_outcome_t o, uint32_t disk_no, uint32_t disk_count, bool saving, char *buf, int cap);`

- [ ] **Step 1: Failing UI tests** in `test/test_nfc_ui.c`:

```c
static void test_next_lines(void) {
    char b[NFC_UI_LINE_BYTES];
    CHECK(strcmp(nfc_ui_next_line(DC_TAP_MOUNTING, 2, 3, false, b, sizeof b), "Next: disk 2 of 3") == 0);
    CHECK(strcmp(nfc_ui_next_line(DC_TAP_MOUNTING, 2, 3, true,  b, sizeof b), "Saving, then disk 2") == 0);
    CHECK(strcmp(nfc_ui_next_line(DC_TAP_SINGLE,   0, 0, false, b, sizeof b), "Next: single disk") == 0);
    CHECK(strcmp(nfc_ui_next_line(DC_TAP_NO_DISK,  0, 0, false, b, sizeof b), "Next: no disk") == 0);
    CHECK(strcmp(nfc_ui_next_line(DC_TAP_IGNORED,  0, 0, false, b, sizeof b), "Tag: too fast") == 0);
    CHECK(strcmp(nfc_ui_next_line(DC_TAP_FAILED,   0, 0, false, b, sizeof b), "Tag: offline") == 0);
}
```

  Check each string fits `DISP_DETAIL_MAX`. If one does not, shorten it, keeping the meaning, and update the test.

- [ ] **Step 2: Implement `nfc_ui_next_line`** in `nfc_ui.c`:

```c
const char *nfc_ui_next_line(dc_tap_outcome_t o, uint32_t disk_no, uint32_t disk_count, bool saving,
                             char *buf, int cap) {
    switch (o) {
    case DC_TAP_MOUNTING:
        if (saving) snprintf(buf, (size_t)cap, "Saving, then disk %lu", (unsigned long)disk_no);
        else snprintf(buf, (size_t)cap, "Next: disk %lu of %lu", (unsigned long)disk_no, (unsigned long)disk_count);
        return buf;
    case DC_TAP_SINGLE:  snprintf(buf, (size_t)cap, "Next: single disk"); return buf;
    case DC_TAP_NO_DISK: snprintf(buf, (size_t)cap, "Next: no disk");     return buf;
    default:             return nfc_ui_tap_line(o, NULL, buf, cap);
    }
}
```

  Also make `nfc_ui_tap_line`'s switch list `DC_TAP_SINGLE`/`DC_TAP_NO_DISK` explicitly (as "Tag: single disk" / "Tag: no disk"), so that `-Wswitch` stays clean.

- [ ] **Step 3: main.c wiring.** Read `main.c` around lines 740–800 (the tap handling) and the core1 poll loop first.
  - Taps: after the `NFC_EV_TAG_READ` branch, add an `NFC_EV_TAG_NEXT` branch:

```c
        } else if (ev.kind == NFC_EV_TAG_NEXT) {
            uint32_t no = 0, count = 0;
            static char title[DC_TITLE_MAX + 1];
            const dc_tap_outcome_t o = online ? dc_tap_next(c, &no, &count, title, sizeof title) : DC_TAP_FAILED;
            const bool saving = psram_image_dirty_count(psram_active_slot()) > 0;
            show = nfc_ui_next_line(o, no, count, saving, line, sizeof line);
            wf_logf(WF_INFO, "nfc: next -> %s", show);
```

  - Write request: in `nfc_core1_write_request`, carry `c->nfc_write_next` into `nfc_wreq_t` as a new `bool next` field. On core0, where `nfc_arm_write(&reader, req.seq, req.disk_id)` is called, call `nfc_arm_write_next(&reader, req.seq)` when `req.next`, and set the armed title to "Next-disk card".
  - Preload gate: register `dc_set_preload_gate(&c, preload_ok, NULL)` with:

```c
// Multi-disk spec §4.3: preload only when nothing else needs the network or
// the idle slot -- no unsent writes, no firmware being staged.
static bool preload_ok(void *ctx) {
    (void)ctx;
    return psram_image_dirty_count(psram_active_slot()) == 0 && !uploader_busy(&g_uploader) && !fw_stage_busy();
}
```

    Use the real predicates. Grep `uploader.c` (line ~147 has the dirty/open check) and the fw_stage API for the exact names, and use exactly what exists.
  - Loop: in the core1 loop, after a `dc_step` that returned `DC_IDLE_POLL` with `!c.poll_interrupted` and no NFC work pending, call `dc_preload_step(&c)` once before the next `dc_step`.
  - Firmware-update idle check (spec §6): wherever the OTA stager checks "idle", also require `!c.preload.loading`.

- [ ] **Step 4: Version.** In `CMakeLists.txt`, set `set(FIRMWARE_SEMVER "1.6.0")`.

- [ ] **Step 5: Host tests and a device build.** Run `wifi-floppy/firmware/test/run.sh 2>&1 | tail -5` and expect all to pass. Then run `pnpm firmware:build 2>&1 | tail -5` and expect it to build with no warnings (CI uses -Werror).

- [ ] **Step 6: Commit.**

```bash
git add wifi-floppy/firmware/src/nfc_ui.h wifi-floppy/firmware/src/nfc_ui.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/test/test_nfc_ui.c
git commit -m "firmware 1.6.0: Next-disk card taps, preload loop, OLED lines"
```

---

### Task 13: e2e — `e2e/next-disk.spec.ts`

**Files:**
- Create: `e2e/next-disk.spec.ts`

**Interfaces:** Consumes `signUpFresh` (`e2e/helpers.ts`) and `pairDevice`, `seedDisk`, `addDisk`, `authHeader`, `cleanupSeeded` (`e2e/device-helpers.ts`). Read their signatures first, and read `e2e/drive-chips.spec.ts` and `e2e/nfc-fob-button.spec.ts` for how a board's status is simulated and how the chip menu is opened at 1280.

- [ ] **Step 1: Write the spec with these tests.** Each seeds its own org and a two- or three-disk title, and uses the device token to POST `/api/device/status` to simulate the board.
  1. **the drive menu offers Next disk and it advances, then wraps**:
     - mount disk 1 (POST `/api/devices/<id>/mount`), then report it mounted via status;
     - open the chip menu: `drive-next-<id>` reads "Next disk: Disk 2 of 2";
     - click it; the DB `desiredDiskId` is disk 2;
     - report disk 2 mounted; the item now reads "Next disk: Disk 1 of 2 (wraps)".
  2. **the preload line shows both states**: status with `preload:{sha256:<disk2 sha>, state:'loading'}` → `drive-preload-<id>` has `data-preload="loading"`; then `state:'ready'` → `data-preload="ready"` and the text "Disk 2 ready (instant swap)".
  3. **no Next disk on a single-disk title**: the menu has no `drive-next-<id>`.
  4. **the device card offers Next and the preload line** on `/devices` (`next-disk-<id>`, `device-preload-<id>`).
  5. **the poll carries next**: GET `/api/device/poll?since=0` with the token has `next.sha256 === disk2.sha256` and `next.diskNo === 2`.
  6. **a Next-card tap advances** (device API): POST `/api/device/tap {action:'next'}` answers `{outcome:'mounting', diskNo:2, diskCount:2}`, and `desiredDiskId` moves.
  7. **Write a Next-disk card button**: after a status report with `nfcReader:'present'`, `/devices` shows `write-next-card`. Clicking it arms the board (the dialog shows the countdown). The poll with `nfcAck=0` returns `nfcWrite.kind === 'next'` and `nfcWrite.diskId === null`. Cancel leaves the next poll's `nfcWrite` with no `kind`.

- [ ] **Step 2: Mobile.** Add one test to `e2e/mobile.spec.ts`: on `/devices` at 390 px, `write-next-card` is visible, fits the viewport (`x + width <= 390`), and the page does not scroll sideways.

- [ ] **Step 3: Run (after Task 14 step 1 has applied the migration).** `PORT=3100 npx playwright test e2e/next-disk.spec.ts e2e/mobile.spec.ts --reporter=line` in the foreground with timeout 540000. Expected: all pass.

- [ ] **Step 4: Commit.**

```bash
git add e2e/next-disk.spec.ts e2e/mobile.spec.ts
git commit -m "e2e: next disk from the menu, the card, a tap, the poll and the card-writing dialog"
```

---

### Task 14: Rollout

- [ ] **Step 1: Apply migration 0027 to the live DB** before any e2e. Use the guarded SQL from Task 1 via the Neon MCP `run_sql`, or a one-off `tsx` script, following HANDOFF's record of 0025. Then verify: `select column_name from information_schema.columns where table_name='devices' and column_name in ('nfc_write_kind','preload_sha256','preload_state')` returns 3 rows.
- [ ] **Step 2: Unit tests, lint and build.** Run `npx vitest run && npx tsc --noEmit -p . && pnpm build`. Everything must be green.
- [ ] **Step 3: Full e2e in foreground chunks of ≤40 tests on PORT=3100.** All must be green. A single `ECONNRESET` flake may be re-run once, by its spec file, and reported.
- [ ] **Step 4: Whole-branch review** (per subagent-driven-development).
- [ ] **Step 5: Merge `--no-ff` to master and push.** Master is production; push is authorised.
- [ ] **Step 6: Publish firmware 1.6.0** with `pnpm firmware:publish` (read the script's usage first), then target the bench board. The board installs when the Amiga is on and idle.
- [ ] **Step 7: Update HANDOFF.** Add a §3ap entry (what shipped, the rulings R1–R3, and the bench list from spec §7). Mark both backlog entries done, noting that ideas 3 and 4 stay open. Then ask the operator for the bench items. That is the last thing in the turn.
