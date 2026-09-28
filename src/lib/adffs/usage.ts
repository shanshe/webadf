// How much of a volume is in use, read from its allocation bitmap.
//
// THE ONE PLACE THE READER TRUSTS THE BITMAP. Everything else in this module
// deliberately ignores it (a disk with a wrong bitmap reads perfectly), so
// this is the only code path where a bad bitmap could produce a wrong ANSWER
// rather than no answer -- hence the checks below, and hence null rather than
// a guess when they fail.
//
// Measured against the operator's archive before it was written: all 46
// readable volumes have bm_flag valid, a bitmap pointer of 881, and a bitmap
// that marks its own block used. The counts agree with amitools' xdftool on
// every disk tried.

import { BLOCK_BYTES } from './constants';
import { geometryOf, BITMAP_FIRST_BLOCK } from './geometry';

export interface VolumeUsage {
  totalBlocks: number;
  usedBlocks: number;
  freeBlocks: number;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** 0-100, for a bar. */
  percentUsed: number;
}

function be32(adf: Uint8Array, offset: number): number {
  return ((adf[offset] << 24) | (adf[offset + 1] << 16)
    | (adf[offset + 2] << 8) | adf[offset + 3]) >>> 0;
}

/**
 * Null when the bitmap cannot be trusted, never a guess.
 *
 * "Unknown" is a fine thing for a disk browser to say; a confidently wrong
 * free-space figure is not, and this is exactly the field where a person
 * would act on it -- deciding whether a file fits.
 */
export function readUsage(adf: Uint8Array): VolumeUsage | null {
  // The disk's own geometry (HD writes spec §6.1). Any other length has no
  // bitmap this code knows where to find.
  const g = geometryOf(adf);
  if (!g) return null;

  const root = g.rootBlock * BLOCK_BYTES;
  // bm_flag is -1 when the bitmap is VALID. Anything else means AmigaDOS
  // itself considers it stale and would rebuild it on mount, so reporting
  // numbers from it would be reporting numbers the Amiga is about to discard.
  if ((be32(adf, root + 312) | 0) !== -1) return null;

  // bm_pages[0], read rather than assumed: 881 DD, 1761 HD on every disk
  // measured, but the root block is where the format says to look.
  const page = be32(adf, root + 316);
  if (page < BITMAP_FIRST_BLOCK || page >= g.blockCount || page === g.rootBlock) return null;

  const bm = page * BLOCK_BYTES;
  let freeBlocks = 0;
  // A SET bit means FREE -- the same inversion the writer documents, and the
  // one thing here most likely to be read backwards. One bitmap block covers
  // either density: 3,518 bits for HD against its 4,064.
  for (let bit = 0; bit < g.blockCount - BITMAP_FIRST_BLOCK; bit++) {
    const o = bm + 4 + (bit >>> 5) * 4;
    if ((be32(adf, o) & (1 << (bit & 31))) !== 0) freeBlocks++;
  }

  // The bitmap must at least claim its own block. A bitmap of all-ones says
  // "every block free" including itself, which is not a real disk -- it is an
  // uninitialised or misread block, and it would tell someone an almost-full
  // disk was empty.
  const selfBit = page - BITMAP_FIRST_BLOCK;
  const selfWord = be32(adf, bm + 4 + (selfBit >>> 5) * 4);
  if ((selfWord & (1 << (selfBit & 31))) !== 0) return null;

  // Used counts the two boot blocks, which are outside the bitmap but are
  // certainly not free space. This is also what xdftool reports, so the two
  // agree disk for disk.
  const usedBlocks = g.blockCount - freeBlocks;
  return {
    totalBlocks: g.blockCount,
    usedBlocks,
    freeBlocks,
    totalBytes: g.blockCount * BLOCK_BYTES,
    usedBytes: usedBlocks * BLOCK_BYTES,
    freeBytes: freeBlocks * BLOCK_BYTES,
    percentUsed: Math.round((usedBlocks / g.blockCount) * 100),
  };
}
