/*
 * Cross-check formatVolume() against an INDEPENDENT implementation.
 *
 * Same idea as `pnpm adfmfm:diff`, which checks the MFM encoder against
 * Greaseweazle, and it exists for a sharper reason here: this repo's own
 * reader deliberately ignores the bitmap, so a disk with a completely wrong
 * bitmap round-trips through readVolume perfectly and only corrupts when a
 * real Amiga writes to it. Unit tests cannot catch that class of bug, because
 * the code that would catch it is the code under test.
 *
 * amitools' xdftool is the second opinion. The decisive step is not that it
 * READS our disk -- it is that it WRITES a file into one, which means it
 * allocated a block out of our bitmap and believed it.
 *
 * Not part of `pnpm test`: xdftool is not a dependency of this project and is
 * not installed in CI. Run it by hand after touching format.ts.
 *
 *   brew install amitools   # or: pipx install amitools
 *   pnpm adffs:verify
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatVolume } from '../src/lib/adffs/format';
import { readVolume, readFile, readUsage } from '../src/lib/adffs';
import { syntheticVolume, type SyntheticOptions } from '../src/lib/adffs/synthetic';
import { ROOT_BLOCK, BLOCK_BYTES, CHECKSUM_WORD } from '../src/lib/adffs/constants';
import {
  addFile, deleteEntry, renameEntry, replaceFile, makeDirectory, moveEntry, applyBatch,
} from '../src/lib/adffs/write';

const dir = mkdtempSync(join(tmpdir(), 'adffs-verify-'));
let failures = 0;

/**
 * On failure, execFileSync's thrown Error carries xdftool's actual output
 * (an "FSError: ..." line) on `.stdout`, NOT in the Error's own message --
 * `String(e)` on the raw throw is just "Command failed: xdftool ...". Every
 * caller here (including the synthetic-fixtures checks below) tests the
 * caught value against /FSError/, so that text has to survive the throw or
 * the check silently never fires. Re-thrown with stdout as the message so
 * `String(e)` in every `catch` block actually contains it.
 */
function xdftool(image: string, ...args: string[]): string {
  try {
    return execFileSync('xdftool', [image, ...args], { encoding: 'utf8' });
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    throw new Error(stdout || String(e));
  }
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Task 5 fix round 1: xdftool CANNOT see a wrong parent pointer.
 *
 * Discovered while mutation-proving moveEntry (task-5-report.md): xdftool's
 * `list`/`write`/`delete`/`type` commands build their directory tree purely
 * by walking hash chains -- amitools assigns each node's in-memory `.parent`
 * from that walk and never reads back the on-disk parent field (header
 * offset 500) to check it agrees. So a `moveEntry` that relinks an entry
 * into a new directory's hash chain but leaves its OLD parent pointer in
 * place is invisible to every xdftool command used above, for exactly the
 * same reason it is invisible to this project's own `readVolume`: neither
 * one ever looks at that field while walking down from the root. Proven by
 * hand: skipping moveEntry's reparent write left every xdftool-based check
 * in this file still green.
 *
 * amitools ships a second, INDEPENDENT opinion that DOES look at it:
 * `amitools.fs.validate.DirScan`, the library behind the `xdfscan` CLI
 * tool. `xdfscan` itself is not used here -- on this machine it crashes
 * before ever opening a disk (`time.clock()` was removed in Python 3.8+,
 * and this amitools release still calls it) -- so `checkParentConsistency`
 * below shells out to the SAME validator library directly, skipping only
 * the broken CLI wrapper around it. This is therefore not "xdftool, again":
 * it is a second, structurally different implementation that actually
 * walks the parent-pointer relationship xdftool's own commands never
 * touch.
 */
const PARENT_CHECK_SCRIPT = `
import sys
from amitools.fs.blkdev.BlkDevFactory import BlkDevFactory
from amitools.fs.validate.Validator import Validator
path = sys.argv[1]
blkdev = BlkDevFactory().open(path, read_only=True)
v = Validator(blkdev, min_level=0)
boot_dos, bootable = v.scan_boot()
root = v.scan_root()
if root:
    v.scan_dir_tree()
    v.scan_files()
    v.scan_bitmap()
v.log.dump()
blkdev.close()
`;

/**
 * Find a Python interpreter that can `import amitools`, memoized for the
 * life of the script. Prefers the interpreter named in xdftool's own
 * shebang line, since that is guaranteed to have amitools installed
 * alongside it (it is how xdftool itself runs); falls back to a bare
 * `python3` in case xdftool was reached some other way.
 */
let amitoolsPython: string | null | undefined;
function findAmitoolsPython(): string | null {
  if (amitoolsPython !== undefined) return amitoolsPython;
  const candidates: string[] = [];
  try {
    const xdftoolPath = execFileSync('which', ['xdftool'], { encoding: 'utf8' }).trim();
    const shebang = readFileSync(xdftoolPath, 'utf8').split('\n')[0];
    const match = /^#!(.+)$/.exec(shebang);
    if (match) candidates.push(match[1].trim());
  } catch { /* fall through to the generic candidate below */ }
  candidates.push('python3');

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'import amitools.fs.validate.DirScan'], { stdio: 'ignore' });
      amitoolsPython = candidate;
      return candidate;
    } catch { /* try the next candidate */ }
  }
  amitoolsPython = null;
  return null;
}

/**
 * Run amitools' own directory-tree validator against `image` and check it
 * does NOT report a parent-pointer inconsistency (`DirScan`'s "invalid
 * parent in ... chain" error -- confirmed by hand against a hand-mutated
 * fixture while wiring this check in; see task-5-report.md).
 *
 * Degrades LOUDLY, not silently, when the validator itself is unavailable:
 * an unreachable python/amitools reports as a FAILED check with a clear
 * reason, the same way the top-of-script xdftool probe below refuses to
 * proceed quietly when xdftool itself is missing. A check that cannot run
 * must never be indistinguishable from a check that ran and passed.
 */
function checkParentConsistency(label: string, image: string): void {
  const python = findAmitoolsPython();
  if (!python) {
    check(`${label}: amitools parent-consistency validator`, false,
      'no Python interpreter with amitools installed was found -- cannot check parent pointers independently');
    return;
  }
  let output: string;
  try {
    output = execFileSync(python, ['-c', PARENT_CHECK_SCRIPT, image], { encoding: 'utf8' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    check(`${label}: amitools parent-consistency validator`, false,
      `validator crashed: ${(err.stderr || err.stdout || String(e)).trim().split('\n')[0]}`);
    return;
  }
  const parentError = output.split('\n').find((l) => /invalid parent/i.test(l));
  check(`${label}: amitools agrees every parent pointer is consistent`, !parentError, parentError ?? '');
}

try {
  execFileSync('xdftool', ['--help'], { stdio: 'ignore' });
} catch {
  console.error('xdftool not found. brew install amitools (or pipx install amitools).');
  process.exit(2);
}

for (const filesystem of ['OFS', 'FFS'] as const) {
  console.log(`\n${filesystem}`);
  const name = `Ours${filesystem}`;
  const image = join(dir, `ours-${filesystem}.adf`);
  writeFileSync(image, formatVolume({ filesystem, volumeName: name }));

  const info = xdftool(image, 'info');
  // A blank disk is 4 blocks: two boot blocks, the root and the bitmap. The
  // boot blocks are not bits in the bitmap, so this number checks our
  // arithmetic against theirs rather than against itself.
  check('xdftool reports 4 blocks used', /used:\s+4\b/.test(info), info.split('\n')[1]?.trim());
  check('xdftool reports 1756 free', /free:\s+1756\b/.test(info), info.split('\n')[2]?.trim());

  const list = xdftool(image, 'list');
  check('volume name and filesystem recognised',
    list.includes(name) && list.includes(filesystem === 'FFS' ? 'ffs' : 'ofs'),
    list.split('\n')[0]?.trim());

  // THE ONE THAT MATTERS. Writing means xdftool allocated a block out of our
  // bitmap. A bitmap that is wrong in the safe direction (everything marked
  // used) makes this fail; wrong in the dangerous direction (everything free)
  // makes it silently overwrite the root or the bitmap itself, which the
  // re-read below then catches.
  const payload = join(dir, 'HELLO');
  writeFileSync(payload, 'hello from the verifier\n');
  xdftool(image, 'write', payload);
  const after = xdftool(image, 'list');
  check('xdftool can write a file into our disk', after.includes('HELLO'));

  const reread = readVolume(new Uint8Array(readFileSync(image)));
  check('our reader still reads it after their write',
    reread.ok && reread.root.some((e) => e.name === 'HELLO'),
    reread.ok ? `entries=[${reread.root.map((e) => e.name).join(', ')}]` : `reason=${reread.reason}`);
}

console.log('\nsynthetic fixtures');
const payload = join(dir, 'payload.bin');
writeFileSync(payload, 'hello from the synthetic verifier\n');
const syntheticFixtures: [string, SyntheticOptions][] = [
  ['OFS file',   { filesystem: 'OFS', volumeName: 'SynOFS',  entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hello amiga') }] }],
  ['FFS file',   { filesystem: 'FFS', volumeName: 'SynFFS',  entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hello amiga') }] }],
  ['FFS INTL',   { filesystem: 'FFS', intl: true, volumeName: 'SynINTL', entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hi') }] }],
  ['FFS nested', { filesystem: 'FFS', volumeName: 'SynDir',  entries: [{ name: 'sub', entries: [{ name: 'in.txt', bytes: new TextEncoder().encode('nested') }] }] }],
];
for (const [label, opts] of syntheticFixtures) {
  const image = join(dir, `syn-${label.replace(/\W/g, '')}.adf`);
  writeFileSync(image, syntheticVolume(opts));
  let listed = '';
  try { listed = xdftool(image, 'list'); } catch (e) { listed = String(e); }
  check(`xdftool opens the ${label} fixture`, !/FSError/.test(listed), listed.split('\n')[0]);
  // The decisive one, same as for formatVolume: can they ALLOCATE into it?
  let wrote = true;
  try { xdftool(image, 'write', payload, 'added.txt'); } catch { wrote = false; }
  check(`xdftool writes into the ${label} fixture`, wrote);
}

// ---------------------------------------------------------------------------
// Task 9: every write operation, proved against xdftool.
//
// Unit tests structurally cannot judge the bitmap: the code that would
// judge it is the code under test. xdftool is the independent second
// opinion, and the decisive step per operation is never that it READS our
// disk -- it is that it WRITES into one afterwards, which only succeeds if
// it allocated a block out of OUR bitmap and believed it.

/**
 * Round-trip one operation's result through xdftool. Returns the temp image
 * path so a caller can run further checks (e.g. confirming a deleted name
 * is really gone) against the same file.
 */
function proves(label: string, adf: Uint8Array, expectNames: string[]): string {
  // An HD image goes to xdftool as `.hdf`: amitools 0.4.0's ADF device is
  // DD-only (see the HD section at the end of this file).
  const ext = adf.length === 1_802_240 ? 'hdf' : 'adf';
  const image = join(dir, `${label.replace(/\W/g, '')}.${ext}`);
  writeFileSync(image, adf);

  let listing = '';
  try { listing = xdftool(image, 'list'); } catch (e) { listing = String(e); }
  check(`${label}: xdftool lists it`, !/FSError/.test(listing));
  for (const n of expectNames) {
    check(`${label}: xdftool sees ${n}`, listing.toUpperCase().includes(n.toUpperCase()));
  }

  // THE ONE THAT MATTERS: they allocate out of OUR bitmap and believe it.
  const writePayload = join(dir, 'theirs.txt');
  writeFileSync(writePayload, 'written by xdftool\n');
  let wrote = true;
  try { xdftool(image, 'write', writePayload, 'theirs.txt'); } catch { wrote = false; }
  check(`${label}: xdftool writes into it`, wrote);

  // ...and we can still read the disk after their write.
  const back = readVolume(new Uint8Array(readFileSync(image)));
  check(`${label}: our reader still reads it`, back.ok, back.ok ? '' : `reason=${back.reason}`);
  return image;
}

/** The block number of a root-level entry, by name (case-insensitive). */
function blockOf(adf: Uint8Array, name: string): number {
  const v = readVolume(adf);
  if (!v.ok) throw new Error(`setup: cannot read volume looking for ${name} (reason=${v.reason})`);
  const entry = v.root.find((e) => e.name.toUpperCase() === name.toUpperCase());
  if (!entry) throw new Error(`setup: ${name} not found in root (have ${v.root.map((e) => e.name).join(', ')})`);
  return entry.block;
}

const smallPayload = new TextEncoder().encode('hello from task 9\n');
// 100 blocks at the smaller of the two per-block sizes (OFS_DATA_BYTES=488)
// still exceeds 72 for FFS too, so both filesystems exercise the extension
// chain, not just one of them.
const largePayload = new Uint8Array(100 * 512).fill(7);

for (const filesystem of ['OFS', 'FFS'] as const) {
  console.log(`\n${filesystem} write operations`);

  {
    const base = formatVolume({ filesystem, volumeName: `Add${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'add.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: add failed (${added.reason})`);
    proves(`${filesystem} add`, added.adf, ['add.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Big${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'big.bin', largePayload);
    if (!added.ok) throw new Error(`setup: add-large failed (${added.reason})`);
    proves(`${filesystem} add-large`, added.adf, ['big.bin']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Ren${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'old.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: rename setup add failed (${added.reason})`);
    const block = blockOf(added.adf, 'old.txt');
    const renamed = renameEntry(added.adf, ROOT_BLOCK, block, 'new.txt');
    if (!renamed.ok) throw new Error(`setup: rename failed (${renamed.reason})`);
    proves(`${filesystem} rename`, renamed.adf, ['new.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Rep${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'replace.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: replace setup add failed (${added.reason})`);
    const block = blockOf(added.adf, 'replace.txt');
    const replaced = replaceFile(added.adf, block, largePayload);
    if (!replaced.ok) throw new Error(`setup: replace failed (${replaced.reason})`);
    proves(`${filesystem} replace`, replaced.adf, ['replace.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Mkd${filesystem}` });
    const made = makeDirectory(base, ROOT_BLOCK, 'sub');
    if (!made.ok) throw new Error(`setup: makeDirectory failed (${made.reason})`);
    proves(`${filesystem} makeDirectory`, made.adf, ['sub']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Aid${filesystem}` });
    const made = makeDirectory(base, ROOT_BLOCK, 'sub');
    if (!made.ok) throw new Error(`setup: add-into-dir mkdir failed (${made.reason})`);
    const dirBlock = blockOf(made.adf, 'sub');
    const added = addFile(made.adf, dirBlock, 'inner.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: add-into-dir add failed (${added.reason})`);
    proves(`${filesystem} add-into-dir`, added.adf, ['sub', 'inner.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Del${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'gone.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: delete-file setup add failed (${added.reason})`);
    const block = blockOf(added.adf, 'gone.txt');
    const deleted = deleteEntry(added.adf, ROOT_BLOCK, block);
    if (!deleted.ok) throw new Error(`setup: delete-file failed (${deleted.reason})`);
    const image = proves(`${filesystem} delete-file`, deleted.adf, []);
    const listing = xdftool(image, 'list');
    check(`${filesystem} delete-file: gone.txt is really gone`, !listing.toUpperCase().includes('GONE.TXT'));
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Ddr${filesystem}` });
    const made = makeDirectory(base, ROOT_BLOCK, 'doomed');
    if (!made.ok) throw new Error(`setup: delete-dir mkdir failed (${made.reason})`);
    const dirBlock = blockOf(made.adf, 'doomed');
    const added = addFile(made.adf, dirBlock, 'inside.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: delete-dir add failed (${added.reason})`);
    const deleted = deleteEntry(added.adf, ROOT_BLOCK, dirBlock);
    if (!deleted.ok) throw new Error(`setup: delete-dir failed (${deleted.reason})`);
    const image = proves(`${filesystem} delete-dir`, deleted.adf, []);
    const listing = xdftool(image, 'list');
    check(`${filesystem} delete-dir: doomed is really gone`, !listing.toUpperCase().includes('DOOMED'));
    check(`${filesystem} delete-dir: inside.txt is really gone`, !listing.toUpperCase().includes('INSIDE.TXT'));
  }
}

// ---------------------------------------------------------------------------
// Task 5: applyBatch and moveEntry, proved against not one but TWO
// independent implementations.
//
// xdftool proves the batch and the move the same way as every other write
// operation above: it lists what we expect, it allocates a block by
// writing into the result, and our reader still reads it after. But for
// the move specifically, xdftool is NOT enough on its own: it never reads
// a header's on-disk parent pointer for any of `list`/`write`/`delete`/
// `type` (see the comment on `checkParentConsistency` above), so a
// reparent that updates the destination's hash chain but leaves the STALE
// parent pointer behind is exactly as invisible to xdftool as it is to
// this project's own `readVolume`. `checkParentConsistency` below is the
// second opinion that actually looks at that field.
for (const filesystem of ['OFS', 'FFS'] as const) {
  console.log(`\n${filesystem} batch and move`);

  const base = formatVolume({ filesystem, volumeName: `Batch${filesystem}` });
  const seeded = addFile(base, ROOT_BLOCK, 'root.txt', smallPayload);
  if (!seeded.ok) throw new Error(`setup: batch seed add failed (${seeded.reason})`);

  // C/ with two files, S/ with one, all via a single applyBatch call.
  const batched = applyBatch([
    { op: 'mkdir', parentPath: '', name: 'C' },
    { op: 'mkdir', parentPath: '', name: 'S' },
    { op: 'add', parentPath: 'C', name: 'one.txt', bytes: smallPayload },
    { op: 'add', parentPath: 'C', name: 'two.txt', bytes: smallPayload },
    { op: 'add', parentPath: 'S', name: 'three.txt', bytes: smallPayload },
  ])(seeded.adf);
  if (!batched.ok) throw new Error(`setup: batch failed (${batched.reason})`);
  proves(`${filesystem} batch`, batched.adf, ['C', 'S', 'one.txt', 'two.txt', 'three.txt']);

  // Move root.txt from the root into C.
  const cBlock = blockOf(batched.adf, 'C');
  const fileBlock = blockOf(batched.adf, 'root.txt');
  const moved = moveEntry(batched.adf, ROOT_BLOCK, fileBlock, cBlock);
  if (!moved.ok) throw new Error(`setup: move failed (${moved.reason})`);
  const image = proves(`${filesystem} move`, moved.adf, ['C', 'root.txt']);
  // proves() only checks the moved name appears SOMEWHERE in xdftool's
  // (recursive) listing; ask xdftool to list C specifically so this checks
  // that xdftool itself, walking its own directory structure, agrees the
  // file now lives there.
  const cListing = xdftool(image, 'list', 'C');
  check(`${filesystem} move: xdftool sees root.txt inside C`, cListing.toUpperCase().includes('ROOT.TXT'));

  // THE CHECK THAT MATTERS for the move: a second, independent
  // implementation that actually reads the parent pointer xdftool never
  // touches.
  checkParentConsistency(`${filesystem} move`, image);
}

console.log('\nsharpest case: delete then refill');
{
  // Add a file large enough to matter, delete it, then make xdftool write a
  // file that only FITS if those blocks really came back. A wrong free
  // either fails here (blocks never freed -> disk-full) or silently
  // double-allocates over live data (blocks freed but still believed used
  // by something else).
  //
  // Sized deliberately past HALF the disk's free capacity (1756 blocks at
  // format time), not just past the 72-block extension threshold: this
  // file plus its own header and extension blocks come to ~964 blocks, so
  // if `free` never gave them back, the OTHER ~792 blocks genuinely still
  // free would not be enough for xdftool to fit a same-size refill anywhere
  // else on the disk. A "large-ish" file (e.g. 700 blocks, as the brief's
  // pseudocode used) leaves too much spare capacity on an otherwise-empty
  // volume for that to happen -- xdftool would just use different free
  // blocks and this check would pass even with a no-op `free` (confirmed by
  // running the Step 4 mutation below with 700 blocks: it did not fail).
  const base = formatVolume({ filesystem: 'FFS', volumeName: 'Reuse' });
  const big = new Uint8Array(950 * 512).fill(1);
  const added = addFile(base, ROOT_BLOCK, 'big.bin', big);
  if (!added.ok) throw new Error(`setup: reuse add failed (${added.reason})`);
  const v = readVolume(added.adf);
  if (!v.ok) throw new Error(`setup: reuse read failed (${v.reason})`);
  const deleted = deleteEntry(added.adf, ROOT_BLOCK, v.root[0].block);
  if (!deleted.ok) throw new Error(`setup: reuse delete failed (${deleted.reason})`);

  const image = join(dir, 'reuse.adf');
  writeFileSync(image, deleted.adf);
  const bigPayload = join(dir, 'big-payload.bin');
  writeFileSync(bigPayload, big);           // same size as what we freed
  let refilled = true;
  try { xdftool(image, 'write', bigPayload, 'refill.bin'); } catch { refilled = false; }
  check('freed blocks are genuinely reusable by xdftool', refilled);

  const listing = refilled ? xdftool(image, 'list') : '';
  check('refill.bin actually landed', listing.toUpperCase().includes('REFILL.BIN'));

  const back = readVolume(new Uint8Array(readFileSync(image)));
  check('our reader still reads the disk after refill', back.ok, back.ok ? '' : `reason=${back.reason}`);
}

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

/**
 * Byte-diff a blank disk against xdftool's OWN `create + format` of the
 * identical geometry, name and filesystem. This is the real check the
 * brief's mutation step needed: "does xdftool accept our disk" is not
 * enough, because xdftool's `list`/`write`/`info` all follow the ROOT's
 * bitmap pointer wherever it leads, so a bitmap moved to the wrong block
 * (Step 5's mutation) still looks fine to every check above. Comparing our
 * bytes against an independent tool's bytes for the SAME format does not
 * have that blind spot.
 *
 * Masked before comparing (measured 2026-09-27 against xdftool's own
 * output -- every one of the 17 bytes that differ between two blank FFS HD
 * disks falls in exactly these ranges, nothing else):
 *   - the root checksum (it covers the date triples, so it changes with them)
 *   - the three date triples (wall-clock timestamps; never equal between
 *     two independent runs)
 *   - the four reserved bytes at root+496..499 (xdftool writes non-zero
 *     bytes there that this project's format leaves zero; AmigaDOS does
 *     not read this field)
 * Anything outside that mask must be identical, or formatVolume disagrees
 * with xdftool about the actual layout.
 */
function checkBlankByteIdentical(label: string, ours: Uint8Array, theirs: Uint8Array): void {
  if (ours.length !== theirs.length) {
    check(label, false, `length ${ours.length} vs ${theirs.length}`);
    return;
  }
  const masked = (adf: Uint8Array): Uint8Array => {
    const out = Uint8Array.from(adf);
    const root = HD_ROOT * BLOCK_BYTES;
    out.fill(0, root + CHECKSUM_WORD * 4, root + CHECKSUM_WORD * 4 + 4); // checksum
    out.fill(0, root + 420, root + 432);                                 // r_days
    out.fill(0, root + 472, root + 484);                                 // v_days
    out.fill(0, root + 484, root + 500);                                 // c_days + reserved
    return out;
  };
  const a = masked(ours);
  const b = masked(theirs);
  let at = -1;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { at = i; break; } }
  check(label, at === -1,
    at === -1 ? '' : `first differing byte at offset ${at} (block ${Math.floor(at / BLOCK_BYTES)})`);
}

console.log('\nHD: our blank disks');
for (const filesystem of ['OFS', 'FFS'] as const) {
  const name = `OursHD${filesystem}`;
  const image = join(dir, `ours-hd-${filesystem}.hdf`);
  const ours = formatVolume({ filesystem, volumeName: name, density: 'hd' });
  writeFileSync(image, ours);

  const theirsImage = join(dir, `xdftool-hd-${filesystem}.hdf`);
  xdftool(theirsImage, 'create', 'chs=80,2,22', '+', 'format', name, filesystem === 'FFS' ? 'ffs' : 'ofs');
  checkBlankByteIdentical(
    `HD ${filesystem}: byte-identical to xdftool's own blank format (masking checksum, dates, root+496..499)`,
    ours, new Uint8Array(readFileSync(theirsImage)));

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

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
