import { requireOrg } from '@/lib/session';
import { searchCandidates } from '@/lib/disk-set-search';

/**
 * Titles the "add to a set" panel can offer, for a manual search or (empty
 * `q`) just the newest 20 (disk-sets spec §4). `exclude` is the title already
 * being built into, so it never offers itself as a candidate.
 */
export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  const exclude = params.get('exclude');

  const titles = await searchCandidates(orgId, q, exclude && exclude.trim() !== '' ? exclude : null);
  return Response.json({ titles });
}
