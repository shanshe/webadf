// The two AmigaDOS floppy geometries (HD writes spec §6.1). An ADF's length
// is the only thing that says which one it is: nothing inside the image is
// trusted for that, the same rule readVolume has always applied to "is this
// an ADF at all". Everything else about the filesystem is identical between
// them -- block size, hash table, header and data blocks, and ONE bitmap
// block (it holds 4,064 bits; an HD disk needs 3,518).
import { BLOCK_BYTES } from './constants';

export type Geometry = Readonly<{
  /** Blocks on the disk: 1,760 DD, 3,520 HD. */
  blockCount: number;
  /** The root block, at the middle of the disk: 880 DD, 1,760 HD. Measured
   *  on both from xdftool's own format (2026-09-27), not assumed. */
  rootBlock: number;
}>;

export const DD_GEOMETRY: Geometry = Object.freeze({ blockCount: 1760, rootBlock: 880 });
export const HD_GEOMETRY: Geometry = Object.freeze({ blockCount: 3520, rootBlock: 1760 });

/** The two boot blocks are outside the bitmap, which starts at block 2. */
export const BITMAP_FIRST_BLOCK = 2;

/** The geometry an image of this length has, or null for any other length. */
export function geometryOf(adf: Uint8Array): Geometry | null {
  if (adf.length === DD_GEOMETRY.blockCount * BLOCK_BYTES) return DD_GEOMETRY;
  if (adf.length === HD_GEOMETRY.blockCount * BLOCK_BYTES) return HD_GEOMETRY;
  return null;
}

export function geometryFor(density: 'dd' | 'hd'): Geometry {
  return density === 'hd' ? HD_GEOMETRY : DD_GEOMETRY;
}
