import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { addDisksToSet, NotFound } from '@/lib/disk-set-store';
import { PlanError } from '@/lib/disk-set';

const body = z.object({
  diskIds: z.array(z.string().min(1).max(64)).min(1).max(64),
  rename: z.string().trim().min(1).max(80).optional(),
});

/** Add disks to title [id] (disk-sets spec §4). Each picked disk brings its whole source title. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    const { undo } = await addDisksToSet(orgId, id, parsed.data.diskIds, parsed.data.rename);
    return Response.json({ undo });
  } catch (err) {
    // Unknown and foreign ids are deliberately indistinguishable.
    if (err instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    if (err instanceof PlanError) {
      return Response.json({ error: err.code }, { status: err.code === 'stale_order' ? 409 : 400 });
    }
    throw err;
  }
}
