// What kind of image a disk row holds. Named "image format", not "kind":
// src/lib/game-kind.ts already means Game/Demo/... by "kind", on the same pages.

// The constants file alone, not '@/lib/adfmfm': client components (the
// dropzone, the drive chips) import this module and must not bundle the
// encoder along with it.
import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm/constants';
import { isHfeName } from '@/lib/blob-upload';

export type { ImageFormat } from '@/db/schema/catalog';

// One rule, shared with both upload clients through blob-upload (which must
// stay import-free for the CLI): the server's too_many_hfe count and the
// clients' batch split have to agree on what an HFE name is.
export const isHfeFilename = isHfeName;

/**
 * THE place that knows what an ADF's size means (HD spec §4.1). An ADF has
 * exactly one of two geometries: 11 sectors a track (DD, 901,120 bytes) or
 * 22 (HD, 1,802,240). Anything else is not a disk the board can play. The
 * SQL twin for WHERE clauses is isHdAdfSql (disk-format-sql.ts).
 */
export function adfDensity(sizeBytes: number): 'dd' | 'hd' | null {
  if (sizeBytes === ADF_BYTES) return 'dd';
  if (sizeBytes === ADF_HD_BYTES) return 'hd';
  return null;
}

/** An HD disk: an ADF row of HD size. An HFE is never "HD" here, whatever its size. */
export function isHdAdf(d: { imageFormat: string; sizeBytes: number }): boolean {
  return d.imageFormat === 'adf' && adfDensity(d.sizeBytes) === 'hd';
}

/**
 * Can the device image route serve this disk? Decided by the row's format
 * and size, never by sniffing the bytes (spec D2). A DD ADF goes out as WFMF
 * (encodeDisk), an HD ADF as WFAD (writeWfad) -- both throw on any other
 * size; an HFE was fully validated at ingest (inspectHfe), and the route
 * re-parses it per request.
 */
export function isServable(d: { imageFormat: string; sizeBytes: number }): boolean {
  if (d.imageFormat === 'adf') return adfDensity(d.sizeBytes) !== null;
  if (d.imageFormat === 'hfe') return true;
  return false;
}
