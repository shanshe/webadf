# Disk sets — design

Date: 2026-09-28. Status: approved in conversation (four sections plus the browser mockup), awaiting spec review.
Backlog entry closed: HANDOFF "Disk groups for sets without disk numbers".
Builds on: `docs/superpowers/specs/2026-09-28-multi-disk-next-design.md` (Next disk, the Next-disk card).

## 1. Intent

**The operator asked for:**
- **Sets without disk numbers.** Disks that belong together but carry no disk numbers must become one named, ordered set that Next disk and the Next-disk card step through. The example is the official AmigaOS 3.1.4 release: `Install3_1_4.adf`, `Workbench3_1_4.adf`, `Extras3_1_4.adf`, `Storage3_1_4.adf`, `Fonts.adf`, `Locale.adf`, `ModulesA1200_3.1.4.adf`.
- **Suggestions at upload.**
- **Manual fix-up at any time.** The operator can name the set, move a disk in, move one out or break one out, and reorder.
- **Clear separation from the higher-level grouping.** It must be intuitive to use.
- **Why now:** this unblocks bench-testing Amiga writes across a set of two or more disks.

**Agreed in conversation:**
- **Words.** The higher level stays **Collections**, as today (the rail, plus type Game/Demo/Utility). The new thing is a **Disk set**, and it lives on the title page.
- **A disk set is a title with several disks.** There is no new object. Order is the existing `disks.disk_no` (1..N). Next disk, the drive menu, "Disk N of M" and the card work unchanged.
- **Where suggestions appear.** At upload (option A) and through manual controls on the title page. Existing library disks are gathered by hand.
- **The title page matches the approved mockup** (`.superpowers/brainstorm/40506-1790627048/content/disk-set-title-page.html`):
  - the set at rest;
  - reorder mode;
  - the Add disks… dialog;
  - a lone disk's "Add to a disk set…";
  - Undo in the toast.

**Success looks like this:**
- The operator drops the 3.1.4 disks.
- They accept a suggested "AmigaOS 3.1.4" set in the right order.
- They mount Install and tap the Next-disk card through the set.
- Amiga writes to any disk of the set land as history versions on that disk.

## 2. Model and rules

- **Moving a disk into a set** (title T):
  - The disk's row gets `game_id = T` and the next free number.
  - A multi-disk source title contributes all its disks, in their order.
  - A source title left with no disks is deleted, with its collection memberships. The disks, blobs and history are untouched.
- **Moving a disk out** makes it a new one-disk title, named after its source filename without the extension (e.g. `amiga-wb31_extras`), falling back to its TOSEC name without the extension, then "Disk", with type copied from the set.
  *Changed by the operator 2026-09-29:* this was the volume name, read from the image at move-out time; move-out no longer reads the image. The title page also stays on the set after a move-out, with an Open action in the toast.
- **Volume names are not stored.** There is no column for them, and they are read from the image with adffs `readVolume`, as the Demozoo sweep does. They are read only where the number of disks is small: the suggestion (the disks of one drop, capped at 32; a larger drop gets no suggestion); move-out no longer reads them (2026-09-29). The Add disks… dialog therefore searches title, source filename and TOSEC name, not volume name.
- **Reordering** renumbers the set's disks 1..N in one step. Duplicate numbers cannot survive it.
- **Human arrangement.** Any add, reorder or move-out sets `games.disk_order_source = 'human'` on the set. Creating a set from a suggestion also sets `metadata_source = 'human'`, since the person typed or accepted its name.
- **Scans leave a human-arranged set alone:**
  - TOSEC apply does not change `disk_no` or `game_id` for its disks, and does not retitle it.
  - Duplicate merging (`mergeDuplicates` in `tosec-apply.ts`) never touches it, neither as the survivor nor as the loser.
  - OpenRetro and Demozoo already skip human-edited names.
- **Devices keep what they hold.** `devices.desired_game_id`/`desired_disk_no` and `mounted_game_id`/`mounted_disk_no` are updated in the same batch for the org's boards whose `desired_disk_id`/`mounted_disk_id` names a moved or renumbered disk. Nothing is ejected, and nothing changes which disk a board holds. Next disk then follows the new order.
- **Scope.**
  - Operations only ever touch disks and titles in the caller's org. A foreign id answers 404, the same as an unknown one.
  - A disk is in exactly one title.
- **Atomicity.** Each operation is one `db.batch` (the neon-http driver has no interactive transactions; `tosec-apply` uses the same pattern).

## 3. Upload suggestion

- **When.** After a whole drop has finished uploading, the page sends the drop's sha256s to `POST /api/disk-sets/suggest`. It considers only disks that are now the only disk of their title AND whose title was created by this drop. Disks that joined a numbered multi-disk title at ingest, or that were already in the library before the drop, are never suggested.
- **Candidates.** At least two such disks, with at least one signal among them:
  - a shared version/tag token in the file names or volume names (e.g. `3_1_4` / `3.1.4`, normalised);
  - volume names that share a pattern (`<Word><tag>`);
  - a common folder name, when a folder was dropped (the browser's `webkitRelativePath`).

  Disks from the same drop without a shared signal are listed too, but unticked (e.g. `Fonts.adf`, `Locale.adf`). If no two disks share a signal, there is no suggestion.
- **Name.**
  - The folder name if a folder was dropped.
  - Otherwise "AmigaOS <tag>" when any name contains "AmigaOS" or a disk's volume starts with `Workbench`/`Install`.
  - Otherwise "<tag> set".
  - It is always editable.
- **Order.** An `Install*` disk first, then `Workbench*`, then the rest in upload order. It can be reordered in the panel.
- **The panel** sits under the upload list:
  - "These N disks look like one set.";
  - a Name field;
  - a checkbox and drag handle per disk;
  - **Make disk set** / **Not a set**.

  Accepting calls the same add-disks operation (§4) with the first ticked disk's title as the set, renamed to the given name. "Not a set" changes nothing.

## 4. Server

- **Migration 0028** (guarded, additive): `ALTER TABLE games ADD COLUMN IF NOT EXISTS disk_order_source text;`
- **`src/lib/disk-set.ts`** (pure, unit-tested):
  - `planAddDisks`: the disks to move, their new numbers, the titles emptied, and the device column updates;
  - `planReorder`: validates that the list equals the set's current disks, then renumbers 1..N;
  - `planMoveOut`;
  - `suggestSets(files: {sha256, filename, volumeName, relativePath?}[])`: groups, name, order and ticked state.
- **Routes.** All are session-authenticated and org-scoped, with 404 for anything outside the org:
  - `POST /api/games/[id]/disks {diskIds: string[]}` adds disks to title `[id]`. It returns `{ok, undo: {…snapshot of each source title: title, year, publisher, type, hadExtras}}`.
  - `PUT /api/games/[id]/disk-order {diskIds: string[]}` reorders. The list must be exactly the title's current disks; otherwise 409.
  - `POST /api/disks/[id]/move-out` returns `{gameId}` of the new title.
  - `POST /api/disks/[id]/undo-move {snapshot}` recreates the source title from the snapshot and moves the disk back. It restores the title name, year, publisher and type. It does NOT restore covers, Demozoo links or collection memberships; the toast says so when `hadExtras`.
  - `POST /api/disk-sets/suggest {sha256s: string[]}` returns the suggestion or `null`.
- **TOSEC apply** skips disks whose game has `disk_order_source = 'human'`, for number and title, and the merge treats such games as untouchable.

## 5. Web

These follow the approved mockup.

- **The title page** (`src/app/(app)/games/[id]/page.tsx`):
  - With two or more disks, a **Disk set** section wraps the existing disk rows, with **Add disks…** and **Reorder**.
  - Each disk row's ⋯ menu gains Move up, Move down and Move out of set.
  - Reorder mode shows drag handles (dnd-kit, as used elsewhere) and ▲▼ buttons, saves each move immediately, and has a **Done** button.
  - The **Add disks…** dialog searches the org's other titles by title, source filename and TOSEC name (volume names are not stored; see §2). Picking a multi-disk title adds all of its disks.
  - Where the mockup shows a volume name in the dialog, it shows the source filename instead.
  - A one-disk title shows **Add to a disk set…** in its row menu, using the same dialog to pick the target. After the move, the page navigates to the set, and a toast reads "Moved to <set>" with **Undo**.
- **The upload page** shows the suggestion panel (§3).
- **The library card and drive menu are unchanged.** A set is one card with "N disks".
- **Phone.** Everything works at 390 px: the ▲▼ buttons, the menus and the dialog.

## 6. Testing

- **Unit:**
  - `disk-set.ts` planners: add (single and multi-disk source), emptied titles, device updates, reorder validation, move-out naming;
  - `suggestSets` with the exact 3.1.4 filenames (Fonts and Locale unticked, Install first, name "AmigaOS 3.1.4"), with a no-signal drop (no suggestion), and with a folder drop;
  - TOSEC apply leaving a human set's numbers and title alone.
- **Route:**
  - org scoping (foreign disk or title is 404);
  - a reorder list that doesn't match (409);
  - an emptied title deleted;
  - device columns following a moved disk;
  - undo restoring the named fields.
- **e2e:**
  - upload files named like the 3.1.4 release, see the suggestion, accept it, and check the order and name;
  - on the title page: add, reorder with buttons and with drag, move out, undo;
  - Next disk and the drive menu follow the new order;
  - a board holding a moved disk keeps it;
  - the same at 390 px.
- **Bench (operator):** the write test across a set of two or more disks (writable disk 2 after a Next-disk swap, and saves landing on the right disk).

## 7. Out of scope

- Picking a disk automatically from an "insert <volume>:" request (multi-disk idea 4).
- Library-wide suggestions for disks already uploaded (option B).
- A disk in more than one set.
