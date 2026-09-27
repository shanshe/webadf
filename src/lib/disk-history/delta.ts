import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm/constants';

/**
 * Sector-level deltas between two ADF images.
 *
 * THE REQUIREMENT THIS SERVES is rewind: the operator wants to step back
 * through a disk's history. That is a constraint on how a write is STORED, not
 * a feature to add afterwards -- the first increment that flattens a write
 * into "the new image" throws away the only thing rewind needs.
 *
 * Why sectors and not tracks. The Amiga rewrites a whole track (11 sectors,
 * 5,632 bytes) to change one byte, because that is how trackdisk works. Saving
 * the track as-written would store 5,632 bytes for a two-byte change and, worse,
 * would record eleven sectors as "changed" when ten are identical -- so a
 * history browser would be unable to say what actually happened. Diffing at 512
 * bytes, the Amiga's own unit, keeps both the storage and the story honest.
 *
 * Why not content-addressed sectors, git-style. A manifest of 1,760 sector
 * hashes is 56 KB per version -- an order of magnitude MORE than a typical
 * write's delta. Dedup is the wrong optimisation for a disk whose versions
 * differ by a handful of sectors.
 */

export const SECTOR_BYTES = 512;
/** A DD disk's sectors. An image's own count is its length / 512. */
export const SECTORS_PER_DISK = ADF_BYTES / SECTOR_BYTES;   // 1760
/** The most sectors any disk here has: an HD disk's (HD writes spec §5.2). */
export const MAX_SECTORS_PER_DISK = ADF_HD_BYTES / SECTOR_BYTES;   // 3520

const MAGIC = 0x5744_4c44;   // 'WDLD', big-endian
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const ENTRY_HEADER_BYTES = 4;

export interface Delta {
  /** Sector indices that differ, ascending. */
  sectors: number[];
  /** New contents, one 512-byte run per index, in the same order. */
  bytes: Uint8Array;
}

export class DeltaError extends Error {
  constructor(message: string) { super(message); this.name = 'DeltaError'; }
}

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

/** Sectors in which `after` differs from `before`. */
export function buildDelta(before: Uint8Array, after: Uint8Array): Delta {
  const sectorsInImage = assertImage(before, 'before');
  assertImage(after, 'after');
  // A disk's versions are all one size (HD writes spec §5.2): a DD image and
  // an HD one are not two states of the same disk.
  if (before.length !== after.length) {
    throw new DeltaError(`before is ${before.length} bytes and after is ${after.length}: a disk has one size`);
  }

  const sectors: number[] = [];
  for (let s = 0; s < sectorsInImage; s++) {
    const at = s * SECTOR_BYTES;
    let same = true;
    for (let i = 0; i < SECTOR_BYTES; i++) {
      if (before[at + i] !== after[at + i]) { same = false; break; }
    }
    if (!same) sectors.push(s);
  }

  const bytes = new Uint8Array(sectors.length * SECTOR_BYTES);
  sectors.forEach((s, n) => {
    bytes.set(after.subarray(s * SECTOR_BYTES, (s + 1) * SECTOR_BYTES), n * SECTOR_BYTES);
  });
  return { sectors, bytes };
}

/** `image` with the delta applied. Does not modify its argument. */
export function applyDelta(image: Uint8Array, delta: Delta): Uint8Array {
  const sectorsInImage = assertImage(image, 'image');
  if (delta.bytes.length !== delta.sectors.length * SECTOR_BYTES) {
    throw new DeltaError('delta payload does not match its sector count');
  }
  const out = image.slice();
  delta.sectors.forEach((s, n) => {
    if (!Number.isInteger(s) || s < 0 || s >= sectorsInImage) {
      throw new DeltaError(`sector ${s} is outside the disk`);
    }
    out.set(delta.bytes.subarray(n * SECTOR_BYTES, (n + 1) * SECTOR_BYTES), s * SECTOR_BYTES);
  });
  return out;
}

/**
 * Serialise a delta.
 *
 *   0  u32  magic 'WDLD'
 *   4  u16  format version
 *   6  u16  sector size
 *   8  u32  sector count
 *  12  u32  reserved (zero)
 *  16  ...  count x (u32 sector index, 512 bytes)
 *
 * Self-describing on purpose: these outlive the code that wrote them, and a
 * blob that cannot say what it is becomes unreadable the first time a constant
 * is changed.
 */
export function encodeDelta(delta: Delta): Uint8Array {
  if (delta.bytes.length !== delta.sectors.length * SECTOR_BYTES) {
    throw new DeltaError('delta payload does not match its sector count');
  }
  const out = new Uint8Array(HEADER_BYTES + delta.sectors.length * (ENTRY_HEADER_BYTES + SECTOR_BYTES));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC);
  dv.setUint16(4, FORMAT_VERSION);
  dv.setUint16(6, SECTOR_BYTES);
  dv.setUint32(8, delta.sectors.length);
  let at = HEADER_BYTES;
  delta.sectors.forEach((s, n) => {
    dv.setUint32(at, s); at += ENTRY_HEADER_BYTES;
    out.set(delta.bytes.subarray(n * SECTOR_BYTES, (n + 1) * SECTOR_BYTES), at);
    at += SECTOR_BYTES;
  });
  return out;
}

export function decodeDelta(src: Uint8Array): Delta {
  if (src.length < HEADER_BYTES) throw new DeltaError('delta is too short to have a header');
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (dv.getUint32(0) !== MAGIC) throw new DeltaError('not a disk delta');
  const version = dv.getUint16(4);
  if (version !== FORMAT_VERSION) throw new DeltaError(`unknown delta format version ${version}`);
  const sectorSize = dv.getUint16(6);
  if (sectorSize !== SECTOR_BYTES) throw new DeltaError(`unexpected sector size ${sectorSize}`);

  const count = dv.getUint32(8);
  const want = HEADER_BYTES + count * (ENTRY_HEADER_BYTES + SECTOR_BYTES);
  if (src.length !== want) {
    throw new DeltaError(`delta claims ${count} sectors (${want} bytes) but is ${src.length}`);
  }

  const sectors: number[] = [];
  const bytes = new Uint8Array(count * SECTOR_BYTES);
  let at = HEADER_BYTES;
  let prev = -1;
  for (let n = 0; n < count; n++) {
    const s = dv.getUint32(at); at += ENTRY_HEADER_BYTES;
    // Bounded by the LARGEST disk: a delta does not say which disk it is for,
    // so applyDelta bounds it again by the image it is applied to.
    if (s >= MAX_SECTORS_PER_DISK) throw new DeltaError(`sector ${s} is outside the disk`);
    // Ascending and unique, enforced rather than assumed: two entries for one
    // sector would make the result depend on apply order, and a delta must
    // mean exactly one thing.
    if (s <= prev) throw new DeltaError('delta sectors must be ascending and unique');
    prev = s;
    sectors.push(s);
    bytes.set(src.subarray(at, at + SECTOR_BYTES), n * SECTOR_BYTES);
    at += SECTOR_BYTES;
  }
  return { sectors, bytes };
}

/** Bytes a delta occupies once encoded. Used to decide delta vs snapshot. */
export function encodedSize(sectorCount: number): number {
  return HEADER_BYTES + sectorCount * (ENTRY_HEADER_BYTES + SECTOR_BYTES);
}

/**
 * Past this share of the disk, store a full snapshot instead.
 *
 * Replaying a chain costs one pass per delta, so a history made only of deltas
 * gets slower without bound. Snapshots are the keyframes that stop that -- and
 * a write that rewrites half the disk (a format, a big install) is both the
 * worst case for replay and the point where a delta stops saving anything.
 */
export const SNAPSHOT_THRESHOLD = 0.5;

/** `imageBytes` is the disk's own size: half of an HD disk is twice half a DD one. */
export function shouldSnapshot(changedSectors: number, imageBytes: number = ADF_BYTES): boolean {
  return encodedSize(changedSectors) >= imageBytes * SNAPSHOT_THRESHOLD;
}
