import { describe, it, expect } from 'vitest';
import { nextDisk, nextInfo, currentDiskId, type NextCandidate, type BoardCaps } from './next-disk';

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
  });
  it('reports loading only when the board says it is loading', () => {
    expect(nextInfo(r, b.sha256, 'loading')?.preload).toBe('loading');
  });
  it('reports waiting -- never loading -- for nothing preloaded or a stale ready record', () => {
    // 'none' and a ready record of a disk no longer next used to read
    // "loading...", which could stay false forever.
    expect(nextInfo(r, null, 'none')?.preload).toBe('waiting');
    expect(nextInfo(r, a.sha256, 'ready')?.preload).toBe('waiting');
    expect(nextInfo(r, null, 'something-new')?.preload).toBe('waiting');
  });

  it('says nothing about preloading for a board too old to report', () => {
    expect(nextInfo(r, null, null)?.preload).toBeNull();
  });
});

describe('currentDiskId', () => {
  it('desired wins over mounted when both are set (a second tap during a swap counts from the WANTED disk)', () => {
    expect(currentDiskId({ desiredDiskId: 'wanted', mountedDiskId: 'mounted' })).toBe('wanted');
  });
  it('falls back to mounted when desired is null', () => {
    expect(currentDiskId({ desiredDiskId: null, mountedDiskId: 'mounted' })).toBe('mounted');
  });
  it('is null when both are null', () => {
    expect(currentDiskId({ desiredDiskId: null, mountedDiskId: null })).toBeNull();
  });
});
