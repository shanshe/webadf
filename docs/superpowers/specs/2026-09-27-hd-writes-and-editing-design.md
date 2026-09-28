# HD disks: Amiga writes, full history, browser editing, blank HD disks — design

Status: approved in conversation 2026-09-27, section by section. Written spec awaits operator review.
Follows `2026-09-26-hd-floppies-read-only-design.md` (read-only HD, firmware 1.4.1, verified on hardware 2026-09-27).

## 1. What this is for

HD disks (1,802,240-byte ADF, 22 sectors/track, 160 tracks) become full citizens: saves made on the Amiga reach the
library as new versions exactly as DD saves do (including saves made while the board is offline); the history panel
shows file-level "what changed", browsable old versions and restore; HD disks can be edited in the browser; and blank
HD disks can be created.

Done means: on the bench (A5000, Kickstart 3.1) an Amiga save to an HD disk appears as a new version whose files can be
browsed; a large multi-track copy verifies; offline saves arrive; restore works; DD behaves exactly as before.

## 2. Decisions taken (operator, 2026-09-27)

| Decision | |
|---|---|
| History for HD is full (option A): file-level diff, browse old versions, restore | operator |
| Browser editing and blank HD disks are in this project, not a follow-up | operator took the recommendation |
| Blank HD disks get a plain DD/HD choice beside OFS/FFS in today's create control; the mobile-friendly redesign of that menu stays on the backlog | this design |
| HD disks stay write-protected by default, like every disk | this design |
| Older boards (1.4.1) keep forcing HD read-only on their own; documented, no capability flag | this design |
| Out of scope: HD in `.dms`, HD HFE | unchanged |

## 3. What the code does today (mapped 2026-09-27)

Firmware: capture window `FLUX_CAPTURE_MAX_MS 400` (= one HD revolution, so HD writes are silently abandoned); capture
buffer `MFM_BUF_BYTES 16384` (~65 % of an HD track); decoder `MFM_SECTORS 11`, `uint16_t found`, `sector_id >= 11`
rejected; `write_back_verdict` completeness `0x7ff`; `psram_image_store` refuses `SLOT_KIND_ADF_HD`; the uploader
re-decodes tracks through `psram_image_read` (refuses ADF_HD) and posts 5,632-byte bodies; `write_back_wprot` forces
WPROT for HD. Server: `isTrackUpload` requires 5,632 bytes (and runs before the HD refusal, so HD gets 400);
`overlayTracks`, `delta.ts`, `chain.ts materialise`, `history.ts` hard-code 901,120 / 1,760 sectors; `restore.ts`,
`disk-write.ts`, `volume-name`, `files/*` and the write-protect PATCH refuse HD; `readDesired` forces `writeProtected`
for HD. adffs: `BLOCK_COUNT = 1760`, `ROOT_BLOCK = 880` hard-coded; `readVolume` returns `not-adf` for any other size.

## 4. Firmware

### 4.1 Capture
- `FLUX_CAPTURE_MAX_MS` 400 → **800** (two HD revolutions).
- `MFM_BUF_BYTES` 16,384 → **28,672** (one HD track, 25,336 bytes, plus margin). ~12 KB more static RAM; the heap
  low-water after TLS was 69,632 bytes on 1.4.1, expected ~57 KB; measured on the bench (§8 step 5).

### 4.2 Decode and verdict
- The decoder accepts sector ids `0 .. nsec-1` where `nsec` is **the mounted disk's** sector count (11 for DD/MFM
  slots, 22 for `SLOT_KIND_ADF_HD`), never inferred from the data. `found` becomes `uint32_t`; the decoded buffer holds
  22 sectors.
- A track is complete when all `nsec` sectors decode with good checksums (`(1u << nsec) - 1`). The existing verdict
  order (token checks, overflow, partial, inconsistent, wrong track) is unchanged; reason strings name the count.
- A DD disk never accepts a 22-sector track; an HD disk never accepts an 11-sector one.

### 4.3 Store
- HD: the verified 11,264 bytes are written straight into the track's `ADF_HD` slot (a new store path that allows
  ADF_HD); the track cache is invalidated so the next read re-encodes it (already how HD is served).
- DD: unchanged (MFM re-encode into the MFM slot).

### 4.4 Upload
- HD: the uploader reads the stored 11,264 bytes directly (`psram_image_track_data`), no re-decode, and posts them.
- The session-close sha-256 covers 160 tracks at the disk's track size (5,632 or 11,264).
- Protocol, sequencing, offline catch-up: unchanged.

### 4.5 Write protection
- `write_back_wprot` stops forcing HD; WPROT follows the server's `writeProtected` (plus the existing `!mounted` and
  uploader-forced terms). The read-only-only code (`WB_REJECT_READ_ONLY`, the `read_only_image` term) is removed.

### 4.6 Version
Firmware **1.5.0**.

## 5. Server: write-back and history

### 5.1 Uploads
- `stageTrack` looks up the disk first and requires a body of **5,632 bytes for DD, 11,264 for HD**; any other size,
  or the wrong one for the disk's type, is `400 invalid_body`.
- `closeSession` overlays tracks at the disk's track size and records a new version (unchanged flow).

### 5.2 History
- `src/lib/disk-history` takes the sector count from the image (1,760 or 3,520). The WDLD delta format is unchanged.
  Every "is this a whole image" check accepts either size, but a version must be the same size as its disk's current
  image (mixing sizes within one disk is refused).
- Restore, browsing old versions and the "what changed" column work for HD (file level via §6).

### 5.3 Read-only removed
Removed: `readDesired`'s forced `writeProtected` for HD; the locked write-protect toggle (disk row) and the drive chips'
Protect `readOnly: 'HD'`; the HD refusals in `device-write.ts`, `disk-write.ts`, `restore.ts`, `volume-name`,
`files/batch`, `files/[block]`, and the write-protect PATCH; the "HD disks can't be browsed in the browser yet"
message and `hd_not_browsable` / `hd_read_only` where they only served read-only. `plays_hd` and the
`hd_unsupported` mount gate stay (they are about playing HD at all).

### 5.4 Older boards
A board on 1.4.1 still forces HD read-only in firmware; an HD disk set writable is still protected on such a board until
it updates. Documented in HANDOFF; no capability flag.

No database migration.

## 6. Filesystem (`src/lib/adffs`), browser editing, blank HD disks

### 6.1 Geometry
- A geometry value `{ blockCount, rootBlock }` is derived from the image length: 901,120 → 1,760/880; 1,802,240 →
  3,520/1,760; anything else stays `not-adf`. Every read/write/allocate/format path takes it instead of the constants.
- No new structures: one bitmap block covers 3,518 bits (capacity 4,064); directory hash tables, file header and data
  blocks are the same size.

### 6.2 Browser editing
All file operations (add, rename, move, delete, folder drop, drag and drop), the free-space bar and the volume name work
for HD; every edit is a new version with file-level "what changed".

### 6.3 Blank HD disks
The create control gets a DD/HD choice beside OFS/FFS (default DD); `/api/disks/create` takes the size and formats a
1.76 MB disk with the chosen filesystem.

### 6.4 Independent check
HD images are checked with `xdftool` in both directions (as `pnpm adffs:verify` does for DD): our blank HD disks open in
xdftool; files we add list and extract there; an xdftool-made HD disk reads correctly in our code.

## 7. Tests

- **vitest, adffs:** the DD suite also runs on HD geometry; format/add/rename/move/delete/allocate cross-checked with
  xdftool both ways.
- **vitest, history:** HD versions record, restore and produce file-level diffs; mixed sizes refused.
- **vitest, write route:** HD tracks are 11,264 bytes; wrong size for the disk's type refused; closing a session yields
  the correct HD image.
- **Firmware host:** an HD track encoded by Greaseweazle (independent) goes through decode → verdict → store →
  uploader read-back and must equal the ADF bytes; an 800 ms capture fits the buffer; a DD disk rejects a 22-sector
  track and an HD disk an 11-sector one.
- **e2e (PORT=3100, full suite before merge):** create a blank HD disk, add and rename a file, see the versions; a
  simulated board's full HD write session; restore an older HD version.

## 8. Bench (A5000 rev 8a.1, Kickstart 3.1)

1. DD regression: a DD disk boots and a DD save still reaches the library.
2. HD save: HD Workbench disk set writable in the web app; `Echo >DF0:hello hi` and `Copy RAM:HDCheck.txt DF0:copy.txt`;
   the new version appears with both files and can be browsed.
3. Large write: a several-hundred-KB copy onto the HD disk; every track verifies and the library's version matches.
4. Offline: save to HD with WiFi down; the version arrives when WiFi returns.
5. Memory: the heap low-water during an HD write stays comfortably above what TLS needs.
6. Restore: an old HD version put back; the Amiga sees it after the disk change.

## 9. Rollout

The web app ships first (1.4.1 boards still protect HD themselves). Firmware 1.5.0 is published to the registry only
after bench steps 1 and 2 pass on it. README and HANDOFF updated.
