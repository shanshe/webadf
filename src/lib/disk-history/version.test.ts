import { describe, it, expect } from 'vitest';
import { ADF_BYTES, ADF_HD_BYTES, HD_TRACK_DATA_BYTES, TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { decodeDelta, SECTOR_BYTES } from './delta';
import type { VersionEntry } from './chain';
import { MAX_CHAIN_DEPTH } from './chain';
import { overlayTracks, planNextVersion, isTrackUpload, trackBytesForDisk, trackBytesForImage } from './version';

const img = (fill = 0) => new Uint8Array(ADF_BYTES).fill(fill);
const track = (fill: number) => new Uint8Array(TRACK_DATA_BYTES).fill(fill);
const v0: VersionEntry = { seq: 0, kind: 'snapshot', blobSha256: 'a', imageSha256: 'a' };

describe('overlayTracks', () => {
  it('replaces exactly the staged tracks and nothing else', () => {
    const out = overlayTracks(img(0), [{ track: 3, data: track(7) }]);
    expect(out[3 * TRACK_DATA_BYTES - 1]).toBe(0);
    expect(out[3 * TRACK_DATA_BYTES]).toBe(7);
    expect(out[4 * TRACK_DATA_BYTES - 1]).toBe(7);
    expect(out[4 * TRACK_DATA_BYTES]).toBe(0);
  });
  it('does not modify the head it was given', () => {
    const head = img(0);
    overlayTracks(head, [{ track: 0, data: track(9) }]);
    expect(head[0]).toBe(0);
  });
  it('refuses a head that is not a disk, or a track out of range', () => {
    expect(() => overlayTracks(new Uint8Array(10), [])).toThrow();
    expect(() => overlayTracks(img(), [{ track: 160, data: track(1) }])).toThrow();
    expect(() => overlayTracks(img(), [{ track: 0, data: new Uint8Array(5) }])).toThrow();
  });
});

describe('isTrackUpload', () => {
  it('accepts tracks 0..159 of exactly 5,632 bytes', () => {
    expect(isTrackUpload(0, track(0))).toBe(true);
    expect(isTrackUpload(159, track(0))).toBe(true);
    expect(isTrackUpload(160, track(0))).toBe(false);
    expect(isTrackUpload(-1, track(0))).toBe(false);
    expect(isTrackUpload(1.5, track(0))).toBe(false);
    expect(isTrackUpload(0, new Uint8Array(5631))).toBe(false);
  });
});

describe('planNextVersion', () => {
  it('is null when nothing changed', () => {
    expect(planNextVersion([v0], img(0), img(0))).toBeNull();
  });
  it('an ordinary save is a delta of only the sectors that changed', () => {
    const next = img(0);
    next[5 * SECTOR_BYTES] = 1;      // one byte in sector 5
    next[900 * SECTOR_BYTES + 3] = 2; // one in sector 900
    const p = planNextVersion([v0], img(0), next)!;
    expect(p.kind).toBe('delta');
    expect(p.sectorCount).toBe(2);
    expect(decodeDelta(p.deltaBlob!).sectors).toEqual([5, 900]);
  });
  it('a rewrite of most of the disk is a snapshot, with no delta blob', () => {
    const p = planNextVersion([v0], img(0), img(1))!;
    expect(p.kind).toBe('snapshot');
    expect(p.deltaBlob).toBeNull();
    expect(p.sectorCount).toBe(ADF_BYTES / SECTOR_BYTES);
  });
  it('snapshots once the chain is MAX_CHAIN_DEPTH deltas long', () => {
    const entries: VersionEntry[] = [v0];
    for (let s = 1; s <= MAX_CHAIN_DEPTH; s++) {
      entries.push({ seq: s, kind: 'delta', blobSha256: `d${s}`, imageSha256: `i${s}` });
    }
    const next = img(0); next[0] = 1;
    expect(planNextVersion(entries, img(0), next)!.kind).toBe('snapshot');
  });
});

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
