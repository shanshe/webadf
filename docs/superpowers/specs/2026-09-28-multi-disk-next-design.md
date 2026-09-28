# Multi-disk titles: "Next disk", a Next-disk NFC card, and preloading — design

Date: 2026-09-28. Status: approved in conversation (four sections), awaiting spec review.
Backlog entries this closes: HANDOFF "Multi-disk games while playing" (ideas 1 and 2 only) and "An NFC card for
swapping disks within the mounted game or utility".

## 1. Intent

**The operator asked for:** a way to advance to the next disk of a multi-disk game or utility while it is running,
and a dedicated NFC card that, tapped on a board, advances that board to the next disk of whatever title is
mounted, instead of naming one disk.

**Agreed in conversation:**
- Scope is backlog ideas 1 and 2: a "Next disk" action plus preloading the next disk into the idle slot. Two-drive
  (DF0 + DF1) emulation and automatic "insert disk 2" detection are out of scope.
- One universal card (option A): it carries no disk and no org. Any Next-disk card works on any board; the board's
  own org and mounted title bound what it can do. After the last disk it wraps to disk 1.
- The server decides what "next" is (approach 1); the board only preloads what the server names.
- Writing a Next-disk card is a button on the **Devices page**, not on a disk (it is org-wide and rare).
- A tap while the board is still uploading saves is accepted; the swap is queued behind the upload.

**Success:** on the bench, a Next-disk tap on a preloaded two-disk title swaps in under 1 s (today ~5 s per
fetch), the Amiga sees an ordinary eject + insert, and no save is lost.

**Measured 2026-09-28 (live DB, all orgs):** 14 titles have more than one disk (2 to 7 disks); none has a gap in
its disk numbers; one has two disks with the same disk number.

## 2. The next-disk rule (server, pure)

`nextDisk(disks, current, board)` in `src/lib/next-disk.ts`, no I/O, unit-tested.

- **Input:** the disks of the current disk's title in the board's org (`id`, `diskNo`, `createdAt`, and what the
  board-capacity check needs), and the current disk id.
- **"Current" is the WANTED disk** (`devices.desiredDiskId`), not the mounted one, so a second tap during a swap
  moves one further instead of repeating the same swap. With no wanted disk it falls back to the mounted disk.
- **Duplicates:** disks sharing a `diskNo` collapse to the oldest (`createdAt`, then `id`), consistently. If the
  current disk is a non-canonical duplicate, "next" still counts from its `diskNo`.
- **Capacity:** a disk the board cannot hold (the existing mount check: HD on a board that cannot take HD, tracks
  longer than its reported `trackMaxBytes`) is skipped.
- **Result:** the lowest `diskNo` above the current one; after the highest, the lowest (wrap).
  - `{ kind: 'disk', disk }` when the result differs from the current disk;
  - `{ kind: 'single' }` when the title has only one usable disk;
  - `{ kind: 'nothing_mounted' }` when there is no current disk, or it no longer belongs to a title.

## 3. Server

### 3.1 Tap: `POST /api/device/tap`

- The body becomes `{ diskId } | { action: 'next' }` (zod union). The disk-id branch is unchanged.
- `action: 'next'` runs through the same guard as a disk tap: the 1 s burst rule (`TAP_MIN_INTERVAL_MS`,
  `lastTapAt`), then `nextDisk`, then the same mount step a disk tap uses (`setDesired`, version bump).
- **Outcomes:** `mounting` (with `diskNo`, `diskCount`), `single`, `nothing_mounted`, `ignored`. Always 200, as
  today (D4).

### 3.2 Web: `POST /api/devices/[id]/next`

- Session-authenticated; the device must belong to the caller's org (the same checks as
  `/api/devices/[id]/mount`).
- Runs `nextDisk` and `setDesired`. Returns `{ outcome, diskNo?, diskCount? }`, using the same outcomes as 3.1 except
  `ignored` (no burst rule from the web).

### 3.3 Poll: the `next` field

- Every poll response that carries `desired` also carries `next`: `{ diskId, sha256, diskNo, diskCount, … }` in
  the same shape as `desired`, or `null` when the rule gives `single` or `nothing_mounted`.
- It is computed when the poll is answered, so a browser edit to the next disk (new blob, new sha256) shows up in
  the next poll. `next` itself is not stored. The only migration in this feature is the three columns in 3.4
  and 3.5.
- Old firmware ignores the unknown field.

### 3.4 Writing a Next-disk card

- `POST /api/nfc/write` accepts `{ kind: 'next', deviceId? }` alongside `{ diskId, deviceId? }`. The pending write
  on the device row records the kind in a new `nfc_write_kind` column (`'disk' | 'next'`, default `'disk'`), added
  in the same migration as 3.5. The poll's `nfcWrite` instruction gains `kind: 'disk' | 'next'`; for `next`,
  `diskId` is absent.
- Everything else is reused unchanged: the 2:00 TTL, the cursor, cancel and read-back.

### 3.5 Status report

- The board reports its preload state as `preload: { sha256, state: 'loading' | 'ready' } | null` in
  `/api/device/status`.
- It is stored on the device row next to the existing live-state columns (one migration: `preload_sha256`,
  `preload_state`).
- Firmware too old to report it leaves both columns NULL.

## 4. Firmware

### 4.1 Tag payload

- WFDK layout unchanged. A Next-disk card is **version 2**: `[0..3] "WFDK"`, `[4] 2`, `[5] 4`, payload ASCII
  `next`, CRC as for v1.
- `nfc_tag_decode` gains the result `NFC_TAG_NEXT`. `nfc_tag_encode_next()` writes it.
- Firmware older than this rejects version 2 as `NFC_TAG_BAD_DATA` and does nothing, which is the safe failure.

### 4.2 Tap

- `NFC_TAG_NEXT` posts `{"action":"next"}` to the tap endpoint.
- The existing 3 s absence rule still applies, so a card left on the reader fires once.
- The OLED shows the outcome for about 2 s:
  - "Disk N of M" (mounting);
  - "Single disk";
  - "No disk";
  - "Offline" (the request failed; nothing is queued locally, because the server decides).
- A tap while dirty tracks are pending is sent normally. The swap it causes waits behind the upload (4.4), and the
  OLED shows "Saving…" until then.

### 4.3 Preloading

- **When:** the poll names `next`, its sha256 differs from what the idle slot holds, and the board is idle:
  - no fetch in progress;
  - **no dirty or unsent tracks** (the idle slot may be needed while a save is outstanding);
  - no firmware stage in progress.
- **How:** the existing streaming loader (`image_parse_begin` on `psram_inactive_slot()`), identical to a fetch
  except that it **does not call `psram_publish_slot()`**. On a complete, verified body it records
  `preload = { slot, sha256, ready }`. An incomplete body leaves no preload record, with no retry storm: the next
  poll retries under the existing backoff.
- **Invalidation:** a different `next` sha256, `next: null`, or any fetch that reuses the idle slot drops the
  record.
- **Never touches the active slot.** Rule 2 of `device_client.c` (no diskless gap) is unaffected.
- HD disks preload in their ADF_HD slot kind exactly as a normal HD fetch does.

### 4.4 Swap

- When `desired` changes:
  - if `preload.ready` and `preload.sha256 == desired.sha256`, publish that slot at once (the normal publish path:
    CHNG eject, then insert);
  - otherwise fetch as today.
- Either way, the existing write-back rule holds: a swap waits until disk N's dirty tracks are uploaded.
- After the swap, the slot that held disk N is the idle slot, and the next poll's `next` preloads N+1 into it.

### 4.5 Card writing

- When the poll's `nfcWrite.kind` is `next`, the board writes the v2 payload and reports the read-back through the
  existing tap-write report.

## 5. Web app

- **Drive menu** (the floppy chip beside the top menu, and the device card on the Devices page):
  - A "Next disk: Disk N of M" item, shown only when the mounted title has more than one usable disk. On the last
    disk it reads "Next disk: Disk 1 of M (wraps)". It calls 3.2.
  - A preload line in both states: "Disk N ready (instant swap)" or "Disk N loading…". It is hidden when the
    board does not report preload state.
- **Devices page header:** a "Write a Next-disk card" button, shown when any board reports an NFC reader. It
  opens the existing write dialog with the board picker. The disk picker is replaced by the line "This card
  switches whatever is mounted to its next disk."
- Disk and title pages are unchanged; each disk's own NFC button still writes that disk.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Duplicate `diskNo` in a title | Oldest counts; the other is still mountable directly |
| Two taps more than 1 s apart | Each advances one disk (counted from the wanted disk) |
| Two taps less than 1 s apart | Second is `ignored` |
| Tap during a swap | Counts from the wanted disk, so it goes one further |
| Next disk edited in the browser after preloading | New sha256 in the poll; stale preload dropped; never swapped to old bytes |
| Board cannot hold the next disk (HD on a DD-only board, long tracks) | Skipped by the rule |
| Tap while saves are uploading | Accepted; swap queued behind the upload; OLED "Saving…" |
| Wi-Fi down at tap | Nothing changes; OLED "Offline" |
| Firmware update waiting for idle | A preload in progress counts as not idle; a completed preload does not |
| Old firmware and a v2 card | `BAD_DATA`, ignored |
| Old firmware and a poll with `next` | Field ignored; swaps fetch as today |

## 7. Testing

- **vitest:**
  - `nextDisk`: wrap, duplicates, single, nothing mounted, wanted-over-mounted, capacity skip;
  - tap route with `action: 'next'` (including the burst rule);
  - `/api/devices/[id]/next` including org scoping (another org's device is 404);
  - the poll's `next` field (present, null, and following a sha256 change);
  - `nfc/write` with `kind: 'next'`;
  - the status route's `preload` field.
- **Firmware host tests:**
  - v2 encode/decode, and v1 unchanged;
  - preload bookkeeping: start conditions, including none while dirty; invalidation; swap-from-preload versus
    fetch; a swap queued behind a pending upload.
- **Playwright:**
  - the drive menu item, its label and the wrap;
  - the preload line in both states;
  - the Devices page button and dialog;
  - the same at 390 px.
- **Bench (operator):**
  - swap time from preload (under 1 s) versus fetch (~5 s);
  - a mid-game card tap on a real two-disk title;
  - a tap during a save upload;
  - writing a card from the Devices page;
  - an old-firmware board ignoring a v2 card, if one is available.

## 8. Out of scope

- DF1 emulation (backlog idea 3).
- "Insert disk 2" detection (idea 4).
- A Previous-disk card.
- Per-title cards.
- Buzzer feedback: comes with the buzzer resistor order.
