import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { encodeDisk, writeWfad } from '@/lib/adfmfm';
import { isHdAdf } from '@/lib/disk-format';
import { HD_UNSUPPORTED } from '@/lib/hd-messages';
import { parseHfe } from '@/lib/hfe/parse';
import { hfeToWfmf } from '@/lib/hfe/to-wfmf';

// Fetch the stored image from Blob, convert (~10 ms), stream ~2 MB out.
export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ sha256: string }> },
) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { sha256 } = await ctx.params;
  if (!SHA256_RE.test(sha256)) {
    return Response.json({ error: 'bad_digest' }, { status: 400 });
  }

  // THE boundary. /api/ingest/check is a deliberate global existence oracle
  // (D13), so a digest is not a secret — TOSEC publishes thousands of them.
  // Serving bytes on digest knowledge alone would turn that accepted risk into
  // a live one. The device's own org must hold the entitlement.
  const owned = await getDb()
    .select({ sha256: entitlements.sha256 })
    .from(entitlements)
    .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, sha256)))
    .limit(1);

  // 404, not 403: a caller learns nothing about whether the blob exists.
  if (owned.length === 0) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  // Which conversion these bytes need is a property of the disk row, never
  // of the bytes' size (spec D2). Scoped to this device's org, like the
  // entitlement above.
  const formats = await getDb()
    .select({ imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })
    .from(disks)
    .where(and(eq(disks.orgId, device.orgId), eq(disks.sha256, sha256)));
  const isHfe = formats.some((r) => r.imageFormat === 'hfe');
  // HD is a property of the row as well (format + size, isHdAdf), never
  // sniffed from the bytes. An HD disk goes out as WFAD: the ADF itself, which
  // the board encodes a track at a time on read (HD spec §4.4, §5.2).
  const isHd = !isHfe && formats.some(isHdAdf);

  // A board built WF_DRIVE_ID=OFF, or one that rolled back from 1.4.0, must
  // never receive HD bytes even if desiredSha256 still names an HD disk (the
  // mount that set it may predate the rollback, or a caller may fetch this
  // route directly). Same device-auth lookup as above, just the one column
  // this route needs -- not a second auth path (final-fix F4).
  if (isHd) {
    const [dev] = await getDb()
      .select({ playsHd: devices.playsHd })
      .from(devices)
      .where(and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId)))
      .limit(1);
    if (!dev?.playsHd) {
      return Response.json({ error: 'hd_unsupported', reason: HD_UNSUPPORTED }, { status: 422 });
    }
  }

  let stored: Uint8Array;
  try {
    stored = await diskStore.read(sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  let body: Uint8Array;
  try {
    if (isHfe) {
      const parsed = parseHfe(stored);
      if (!parsed.ok) throw new Error(parsed.reason);
      body = hfeToWfmf(parsed.disk);
    } else if (isHd) {
      body = writeWfad(stored);
    } else {
      body = encodeDisk(stored);
    }
  } catch (e) {
    // A stored blob that will not encode is our bug or a corrupt object, not
    // the device's fault -- but it is also never going to start encoding on a
    // retry. setDesired (src/lib/mount.ts) mounts only what isServable
    // accepts, so this path should be unreachable for a freshly mounted disk;
    // it remains for a disk that became desired before that guard existed.
    // 422, not 500: this is permanent, not transient, and a device must not
    // treat it as a server fault worth retrying.
    return Response.json(
      { error: 'encode_failed', sha256, detail: (e as Error).message },
      { status: 422 },
    );
  }

  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // Computed, never a constant: an HFE's tracks keep their own lengths,
      // and WFAD (1,802,256) is not WFMF (2,027,536).
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    },
  });
}
