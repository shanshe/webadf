import {
  ADF_HD_BYTES, HD_SECTORS, TRACKS, WFAD_BYTES, WFAD_HEADER_BYTES, WFAD_MAGIC, WFAD_VERSION,
} from './constants';
import { AdfmfmError } from './errors';

export class WfadFormatError extends AdfmfmError {
  constructor(message: string) {
    super(message);
    this.name = 'WfadFormatError';
  }
}

/**
 * The container the board loads an HD disk from (HD spec §4.4): a header, then
 * the ADF unchanged. The ADF is already track-major (track = cylinder * 2 +
 * head, 22 x 512 bytes each), which is exactly the order image_loader.c fills
 * PSRAM slots in, so there is nothing to reorder -- only to refuse anything
 * that is not one whole HD image.
 */
export function writeWfad(adf: Uint8Array): Uint8Array {
  if (adf.length !== ADF_HD_BYTES) {
    throw new WfadFormatError(`an HD ADF is ${ADF_HD_BYTES} bytes, got ${adf.length}`);
  }
  const out = new Uint8Array(WFAD_BYTES);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, WFAD_MAGIC, true);
  dv.setUint32(4, WFAD_VERSION, true);
  dv.setUint32(8, TRACKS, true);
  dv.setUint32(12, HD_SECTORS, true);
  out.set(adf, WFAD_HEADER_BYTES);
  return out;
}
