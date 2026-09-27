// The TS encoder's MFM for real disks (HD spec §5.2), as fixtures for
// the C port's host test (wifi-floppy/firmware/test/test_adf_mfm.c).
//
//   tsx scripts/adf-mfm-real-fixtures.ts <out-dir> <adf>...
//
// Writes <out-dir>/<i>.mfm (160 tracks x 12,668 bytes, from src/lib/adfmfm's
// encodeTrack) and <out-dir>/manifest.txt ("<adf path>\t<mfm path>" per line).
// The output is derived from real disks, so it goes under test/.build
// (gitignored) and is never committed -- the same rule as adf-archive/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodeTrack } from '../src/lib/adfmfm/track';
import { adfTrack, assertAdf } from '../src/lib/adfmfm/adf';
import { TRACKS, TRACK_BYTES } from '../src/lib/adfmfm/constants';

const [dir, ...adfs] = process.argv.slice(2);
if (!dir || adfs.length === 0) throw new Error('usage: adf-mfm-real-fixtures.ts <out-dir> <adf>...');
mkdirSync(dir, { recursive: true });
const manifest: string[] = [];
adfs.forEach((path, i) => {
  const adf = new Uint8Array(readFileSync(path));
  assertAdf(adf);
  const out = new Uint8Array(TRACKS * TRACK_BYTES);
  for (let t = 0; t < TRACKS; t++) out.set(encodeTrack(adfTrack(adf, t), t), t * TRACK_BYTES);
  const mfm = resolve(join(dir, `${i}.mfm`));
  writeFileSync(mfm, out);
  manifest.push(`${resolve(path)}\t${mfm}`);
  console.log(`wrote ${mfm} <- ${path}`);
});
writeFileSync(join(dir, 'manifest.txt'), manifest.join('\n') + '\n');
