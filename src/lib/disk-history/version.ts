import { ADF_BYTES, ADF_HD_BYTES, HD_TRACK_DATA_BYTES, TRACK_DATA_BYTES, TRACKS } from '@/lib/adfmfm/constants';
import { adfDensity } from '@/lib/disk-format';
import { buildDelta, encodeDelta } from './delta';
import { nextKind, deltasSinceSnapshot, type VersionEntry, type VersionKind } from './chain';

/**
 * Turning a write session into the next version of a disk (write-back spec
 * §3.4). Pure: the store (store.ts) does the I/O, this decides what to store.
 */

export interface StagedTrack { track: number; data: Uint8Array }

/** One track's sector data for an image of this size: 5,632 DD, 11,264 HD
 *  (HD writes spec §5.1). Null for any other size. */
export function trackBytesForImage(imageBytes: number): number | null {
  if (imageBytes === ADF_BYTES) return TRACK_DATA_BYTES;
  if (imageBytes === ADF_HD_BYTES) return HD_TRACK_DATA_BYTES;
  return null;
}

/** The same, from a disk row. An HFE takes no uploads (spec D2): null. */
export function trackBytesForDisk(d: { imageFormat: string; sizeBytes: number }): number | null {
  if (d.imageFormat !== 'adf') return null;
  const density = adfDensity(d.sizeBytes);
  if (density === 'hd') return HD_TRACK_DATA_BYTES;
  if (density === 'dd') return TRACK_DATA_BYTES;
  return null;
}

/** A track the board may upload: 0..159, exactly one track of `trackBytes`
 *  (this disk's size; DD unless told otherwise). */
export function isTrackUpload(track: number, data: Uint8Array, trackBytes: number = TRACK_DATA_BYTES): boolean {
  return Number.isInteger(track) && track >= 0 && track < TRACKS
    && data.length === trackBytes;
}

/** `head` with each staged track written over it, at the head's own track
 *  size. Does not modify `head`. */
export function overlayTracks(head: Uint8Array, tracks: readonly StagedTrack[]): Uint8Array {
  const trackBytes = trackBytesForImage(head.length);
  if (trackBytes === null) {
    throw new Error(`head must be ${ADF_BYTES} or ${ADF_HD_BYTES} bytes, got ${head.length}`);
  }
  const out = head.slice();
  for (const t of tracks) {
    if (!isTrackUpload(t.track, t.data, trackBytes)) throw new Error(`not a track upload: track ${t.track}`);
    out.set(t.data, t.track * trackBytes);
  }
  return out;
}

export interface PlannedVersion {
  kind: VersionKind;
  /** Sectors that differ from the previous version. */
  sectorCount: number;
  /** The encoded WDLD delta for a 'delta'; null for a 'snapshot' (the image is the blob). */
  deltaBlob: Uint8Array | null;
}

/** What to record for `next`, given the history so far. Null when nothing changed. */
export function planNextVersion(
  entries: readonly VersionEntry[], head: Uint8Array, next: Uint8Array,
): PlannedVersion | null {
  const delta = buildDelta(head, next);
  if (delta.sectors.length === 0) return null;
  const kind = nextKind(delta.sectors.length, deltasSinceSnapshot(entries), next.length);
  return {
    kind,
    sectorCount: delta.sectors.length,
    deltaBlob: kind === 'delta' ? encodeDelta(delta) : null,
  };
}
