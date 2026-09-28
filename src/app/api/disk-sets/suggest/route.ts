import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { SHA256_RE } from '@/lib/ingest';
import { suggestFromUpload } from '@/lib/disk-set-search';

/** since more than this far in the past is refused (Task 6 controller ruling 2). */
const MAX_SINCE_AGE_MS = 24 * 60 * 60 * 1000;

const body = z.object({
  sha256s: z.array(z.string().regex(SHA256_RE)).min(1).max(32),
  // Strict ISO 8601 (z.iso.datetime's default: 'Z', no bare offset, no
  // missing timezone) -- this is client-supplied, so a loosely-parsed value
  // could otherwise widen the query below to any disk the org ever ingested.
  since: z.iso.datetime(),
  paths: z.record(z.string().regex(SHA256_RE), z.string().min(1).max(4096)).optional(),
});

/**
 * The upload page's set suggestion, fired right after a batch lands
 * (disk-sets spec §3): among the disks this upload just registered, is there
 * a set to offer? `sha256s` and `paths` come straight from the client, but
 * `since` is the one value trusted enough to widen the query, so it is
 * re-checked here rather than taken on faith.
 */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const since = new Date(parsed.data.since);
  if (Date.now() - since.getTime() > MAX_SINCE_AGE_MS) {
    return Response.json({ error: 'since_too_old' }, { status: 400 });
  }

  const suggestion = await suggestFromUpload(orgId, parsed.data.sha256s, since, parsed.data.paths);
  return Response.json({ suggestion });
}
