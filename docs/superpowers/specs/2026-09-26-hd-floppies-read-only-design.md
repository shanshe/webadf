# HD floppies, read-only — design

Status: approved in conversation 2026-09-26, section by section. Written spec awaits operator review.

## 1. What this is for

The operator wants 1.76 MB HD Amiga disks in the library and playing on a real Amiga through
the board, on a par with the 880 KB DD disks. This first release is **read-only on the Amiga:
boot and load**. Saves, browser editing of HD disks, and blank HD disks come later.

Done means: an HD ADF uploaded to the library boots and loads on the bench Amiga through the
board; DD disks, HFE and DF1 behave exactly as before; swapping between DD and HD works (with
a reset if Kickstart requires one, see §5.4).

## 2. Decisions taken

| Decision | By, when |
|---|---|
| HD is held on the device as ADF and encoded to MFM on demand, per track | operator ruling 2026-09-13, re-confirmed 2026-09-26 (approach A) |
| v1 is read-only on the Amiga: boot and load; saves later | operator, 2026-09-26 |
| v1 has no browser file editing, no history and no blank-disk creation for HD | operator took the recommendation, 2026-09-26 |
| Kickstart 3.0+ is required for HD; older Kickstarts are documented, not worked around | operator ruling 2026-09-13 |
| Out of scope: HD in `.dms`, HD HFE, Amiga writes to HD disks | this design |

## 3. What the spike measured (2026-09-26, HANDOFF backlog "HD floppies -- SPIKE DONE")

- One HD track (22 sectors, 202,688 bits, 25,336 bytes of MFM) encodes on the RP2350 in a
  median 3.7 ms from SRAM, 4.1 ms reading the ADF from PSRAM, worst seen 4.9 ms. The head
  settle budget is ~15 ms.
- `adf_mfm.c` (branch `spike/hd-floppy`) is byte-identical to `src/lib/adfmfm` on 5 real DD
  disks x 160 tracks and to Greaseweazle's HD encoding.
- A PIO state machine answering one ID bit on RDY per motor-off SEL0 select works at bus
  speed. The DD build answered 32 selects and booted Workbench 3.1.
- **Its phase was one select early.** Logical `0xAAAAAAAA` on the wire gave a black screen
  (invalid ID, DF0 never accessed); `0x55555555` on the wire made Kickstart 3.1 treat DF0 as
  HD ("read error on block 56" on a DD disk, as expected). Kickstart read the ID again later
  while running (a second burst of 49 motor-off selects after track reads).
- Firmware RAM today: 342 KB of 512 KB used by static data, ~170 KB free.

## 4. Library and server

### 4.1 Recognising HD
- An ADF (`imageFormat = 'adf'`) of exactly 1,802,240 bytes is HD; 901,120 bytes is DD. No
  schema change for disks: one helper, `adfDensity(sizeBytes): 'dd' | 'hd' | null`, in
  `src/lib/disk-format.ts`, is the only place that knows the two sizes' meaning.
- Ingest already accepts HD ADFs and `.adz` (size cap 2.5 MiB). `.dms` keeps its DD-only
  rejection.
- TOSEC identification matches on crc32 + size and needs no change.

### 4.2 In the library
- HD disks show an "HD" tag beside their size wherever size is shown (`disk-row.tsx`,
  `game-table.tsx`, the dropzone result).
- The disk page's file browser says "HD disks can't be browsed in the browser yet" instead
  of today's "not a standard 880 KB ADF". The file, volume-name, history and edit routes
  keep refusing HD disks; they must refuse with that reason, not crash or mislabel.

### 4.3 Mounting
- `isServable` accepts HD ADFs.
- The board reports the capability in its status: `playsHd: true` (absent means false).
  Stored as a new `devices.playsHd boolean not null default false` column, set from each
  status report.
- `setDesired` refuses an HD disk on a device whose `playsHd` is false with a new reason,
  `hd_unsupported`, alongside the existing `track_too_long`. Every mount entry point (web
  mount, drive chips, NFC tap) surfaces it as "Update the drive's firmware to play HD disks".
  An NFC tap of an HD disk on such a board is refused the same way, not silently dropped.
- `readDesired` always sends an HD disk with `writeProtected: true`, whatever the disk's
  library setting. The write-protect toggle is disabled for HD disks in the UI.
- The write routes (`device-write.ts`, `disk-write.ts`) refuse writes to HD disks, as they do
  for HFE (`409`, reason `hd_read_only`).

### 4.4 What the board downloads
`GET /api/device/image/[sha256]` keeps sending WFMF for DD and HFE, unchanged. For an HD disk
it sends a **WFAD** container, all integers little-endian like WFMF:

| offset | bytes | field |
|---|---|---|
| 0 | 4 | magic `WFAD` (a new constant beside `WFMF_MAGIC`) |
| 4 | 4 | version = 1 |
| 8 | 4 | tracks = 160 |
| 12 | 4 | sectors per track = 22 |
| 16 | 1,802,240 | the ADF, track-major (track = cylinder x 2 + head), 22 x 512 bytes each |

Total 1,802,256 bytes. The writer lives in `src/lib/adfmfm/wfad.ts` and throws on any other
input size.

## 5. Firmware

### 5.1 Loading
- `image_loader.c` dispatches on the magic. WFMF takes today's path unchanged.
- WFAD is validated before anything is published: version 1, 160 tracks, 22 sectors, body
  exactly 1,802,240 bytes. Any failure rejects the whole image, as an oversized WFMF track
  does today; a partly loaded disk is never mounted.
- Each track's 11,264 bytes go into that track's existing PSRAM slot (14,336 bytes per
  track, unchanged). The slot records its kind: `MFM` (ready to play) or `ADF_HD` (encode on
  read). `device_image`, the slot count and the 2 MiB firmware stage do not change.

### 5.2 Serving a track
- `track_cache_get` on a miss copies from PSRAM today. For an `ADF_HD` slot it instead
  encodes the track's sector data with `adf_mfm.c` straight into the idle SRAM buffer and sets
  `bit_count = 202,688`. The token-tagged double buffer and its stale-track guarantee apply
  unchanged.
- Streaming is unchanged: the revolution follows `bit_count`, so an HD revolution is 400 ms
  at the same 2 us cell and INDEX fires at the wrap.
- The SRAM buffers (`track_cache.c` `buf[2]`, `main.c` `track_words`) are sized by a new
  `TRACK_BUF_BYTES = 25,344` (25,336 rounded up to 4), separate from the PSRAM stride
  `TRACK_MAX_BYTES`. Cost ~33 KB, leaving ~140 KB free.
- The plan must establish where `track_cache_get` runs. The 4-5 ms encode must not run in an
  interrupt handler; if the call site is one, the encode moves to the point where the next
  buffer is prepared.

### 5.3 Read-only
- With an `ADF_HD` disk mounted the board drives WPROT asserted, independent of the server's
  `writeProtected` (joins the `wprot = ...` expression in `main.c`).
- A write captured while an HD disk is mounted is discarded and never uploaded.

### 5.4 Drive ID
- The spike's PIO `drive_id` program (pio0, clkdiv 1) becomes permanent, gated on SEL0 only,
  so a real drive on DF1 is untouched.
- **Phase:** the select that resets the ID (first motor-off select after the motor was on)
  carries no bit; bit 31 goes out on the next motor-off select. The reference is a host test
  in `test/test_drive_id.c` that plays the Amiga's sequence (motor on, motor off, 32
  selects) through the pure model in `drive_id.c` and asserts the Amiga reads `0xAAAAAAAA`
  for HD and `0xFFFFFFFF` for DD, sampling RDY active-low. The PIO program is changed to match
  the model. The bench workaround word `0x55555555` is not used.
- **What it answers:** `ADF_HD` disk mounted: HD `0xAAAAAAAA`. DD, HFE or no disk: DD
  `0xFFFFFFFF`. The main loop pushes the new word when the mounted kind changes; the PIO takes
  it at the next reset select, never mid-answer.
- **Swapping without a reboot:** whether Kickstart 3.x re-reads the ID on a disk change is
  tested on the bench (§7, step 9). If it does not, the fallback is documented, not
  engineered: the web app notes "reset the Amiga (Ctrl-Amiga-Amiga) after switching between
  DD and HD" when a disk of the other density is mounted.
- **Kill switch:** build option `WF_DRIVE_ID=OFF` removes the responder. With it off the board
  reports `playsHd: false`, so the server refuses HD mounts cleanly.

### 5.5 Status
The status report adds `playsHd: true` when the drive-ID responder is built in.

## 6. Failure handling

| Case | Result |
|---|---|
| HD mount on a board without `playsHd` | refused, "Update the drive's firmware to play HD disks" |
| WFAD truncated, wrong version, wrong size | whole image rejected, nothing published, logged |
| Amiga writes to an HD disk | Amiga shows "Disk is write protected"; any captured write discarded |
| Server asked to write an HD disk | `409 hd_read_only` |
| HD disk opened in the file browser | "HD disks can't be browsed in the browser yet" |
| Kickstart < 3.0 | HD disk does not read; documented |

## 7. Tests

**Web (vitest):** `adfDensity`; `isServable` for HD; `setDesired` returns `hd_unsupported`
for a device without `playsHd` and succeeds with it; `readDesired` forces `writeProtected`
for HD; write routes return `hd_read_only`; the WFAD writer byte for byte against a golden
file, and rejects wrong sizes.

**Web (e2e, port 3100, full suite green before merge):** upload an HD ADF and see the HD tag
and the disk-page message; mount it on a simulated device that reports `playsHd` (accepted)
and one that does not (refused with the message).

**Firmware (host):** WFAD loader accepts valid and rejects truncated, wrong-version and
wrong-size containers; an end-to-end host test runs WFAD -> loader -> `track_cache_get` for
all 160 tracks and compares each against **Greaseweazle's** HD encoding of the same ADF
(independent verifier); the stale-track guarantee on HD slots; the drive-ID phase test;
WPROT forced for `ADF_HD`.

**Test disk:** a bootable HD ADF built with `xdftool` (1.76 MB, FFS), the Workbench 3.1 files
copied onto it and a boot block installed, plus one known file whose checksum is recorded.
Also look for real HD ADFs from TOSEC in the library to try one not built here.

**Bench checklist (each step a visible pass/fail):**
1. DD Workbench 3.1 boots (regression)
2. A DD game loads (regression)
3. Turrican (HFE) boots (regression)
4. DF1 with the real drive works (regression)
5. NFC tap mounts a DD disk (regression)
6. The HD Workbench disk boots
7. Its Workbench window shows ~1.7 MB capacity; the known file copies to RAM: and its checksum matches
8. Saving to the HD disk gives "Disk is write protected"
9. Swap DD -> HD and HD -> DD while running; record whether a reset is needed (§5.4)
10. The serial log's low-water mark of free heap confirms the RAM headroom

## 8. Rollout
- The web app ships first. It refuses HD mounts until a board reports `playsHd`, so the order
  is safe.
- Firmware 1.4.0 goes out through the release registry and updates from the web app.
- `README.md` and the end-user feature list gain HD (read-only, Kickstart 3.0+).

## 9. Out of scope (next steps, in order)
1. Browser editing, history and blank HD disks (`adffs` geometry parameterised; root block
   1760, 3,520 blocks, one bitmap block still suffices).
2. Amiga writes to HD disks (write-back decode for 22 sectors).
3. HD in `.dms` and HD HFE.
