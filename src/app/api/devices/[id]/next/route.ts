import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { requireOrg } from '@/lib/session';
import { setDesired } from '@/lib/mount';
import { readNextForDevices } from '@/lib/next-disk';
import { TRACK_TOO_LONG } from '@/lib/hfe/messages';
import { HD_UNSUPPORTED } from '@/lib/hd-messages';

export const maxDuration = 60;

// CSRF: as mount/route.ts -- relies entirely on Better Auth's default
// `SameSite=Lax` session cookie. Same caveat: if crossSubDomainCookies or
// sameSite:'none' is ever configured, this route needs an explicit origin
// check too.

/**
 * The drive menu's "Next disk" (multi-disk spec §3.2): the same rule and the
 * same mount step as the Next-disk card. CSRF: as the mount route (SameSite=Lax).
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;
  const [dev] = await getDb().select({
    id: devices.id, desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId,
    trackMaxBytes: devices.trackMaxBytes, playsHd: devices.playsHd,
  }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!dev) return Response.json({ error: 'not_found' }, { status: 404 });

  const next = (await readNextForDevices(orgId, [dev])).get(dev.id)!;
  if (next.kind !== 'disk') return Response.json({ outcome: next.kind });
  const r = await setDesired(orgId, deviceId, next.disk.id);
  if (!r.ok && r.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (!r.ok && r.reason === 'hd_unsupported') {
    return Response.json({ error: 'hd_unsupported', reason: HD_UNSUPPORTED }, { status: 409 });
  }
  if (!r.ok) return Response.json({ error: 'track_too_long', reason: TRACK_TOO_LONG }, { status: 409 });
  return Response.json({ outcome: 'mounting', diskNo: next.disk.diskNo, diskCount: next.diskCount });
}
