import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { undoMove, NotFound } from '@/lib/disk-set-store';

const snapshot = z.object({
  diskIds: z.array(z.string().min(1).max(64)).min(1).max(64)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate disk ids'),
  title: z.string().min(1).max(200),
  sortTitle: z.string().min(1).max(200),
  year: z.number().int().min(1900).max(2100).nullable(),
  publisher: z.string().max(200).nullable(),
  metadataSource: z.string().max(32).nullable(),
  hadExtras: z.boolean(),
});
const body = z.object({ snapshot });

/**
 * Undo an add (disk-sets spec §4): recreate the source title from the snapshot
 * the add returned and move its disks back. Covers, Demozoo links and
 * collection memberships are not restored (the client says so when hadExtras).
 * [id] must be one of the snapshot's disks.
 */
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
  if (!parsed.data.snapshot.diskIds.includes(id)) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    await undoMove(orgId, parsed.data.snapshot);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    throw err;
  }
}
