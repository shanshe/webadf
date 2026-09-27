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
    // The bitmap block's padding bits past block 3519 are set ("free"); they must
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
