/**
 * Disk sets (spec 2026-09-28-disk-sets §3, Task 6): the two org-scoped reads
 * behind the upload-page suggestion and the manual "add to a set" search.
 *
 * disks.orgId can drift from its game's own orgId (nothing in the schema
 * prevents it -- src/lib/search.ts's header documents the same fact), so
 * every join onto disks here carries BOTH gameId and orgId, never gameId
 * alone.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { orgFilter } from '@/db/scope';
import { likePattern } from '@/lib/search-query';
import { readVolume } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { suggestSet, type SuggestInput, type Suggestion } from '@/lib/disk-set-suggest';

/**
 * The volume name, normalised to null on a blank or whitespace-only label
 * (controller ruling: real Amiga disks often carry one) as well as on any
 * read failure -- suggestSet falls back to the filename only for null, never
 * for '', so an unnormalised blank label would suppress that fallback.
 */
async function readVolumeName(sha256: string): Promise<string | null> {
  try {
    const v = readVolume(await diskStore.read(sha256));
    if (!v.ok) return null;
    const name = v.volume.name.trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/**
 * The org's disks that just landed with the given hashes, whose game (a) was
 * created no earlier than `since` (P3 -- this call's own batch, not the
 * org's whole history), (b) has exactly one disk in total, not merely one
 * among `sha256s`, and (c) has never been arranged by a person
 * (disk_order_source IS NULL). Read for each: its volume label and this
 * org's own filename for it, then handed to the pure suggestSet.
 */
export async function suggestFromUpload(
  orgId: string, sha256s: string[], since: Date, paths: Record<string, string> | undefined,
): Promise<Suggestion> {
  const db = getDb();

  const rows = await db.select({
    diskId: disks.id, gameId: disks.gameId, sha256: disks.sha256,
    sourceFilename: entitlements.sourceFilename, tosecName: disks.tosecName,
  })
    .from(disks)
    .innerJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, orgId)))
    .leftJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(
      eq(disks.orgId, orgId),
      inArray(disks.sha256, sha256s),
      gte(games.createdAt, since),
      isNull(games.diskOrderSource),
      sql`(select count(*) from disks d2 where d2.game_id = ${games.id} and d2.org_id = ${orgId}) = 1`,
    ));

  const inputs: SuggestInput[] = [];
  for (const r of rows) {
    inputs.push({
      diskId: r.diskId,
      gameId: r.gameId,
      // The entitlement is this org's own record of what it called the file;
      // a disk somehow missing one (should not happen post-ingest) falls
      // back to the catalog filename rather than dropping out of the batch.
      filename: r.sourceFilename ?? r.tosecName ?? '',
      volumeName: await readVolumeName(r.sha256),
      relativePath: paths?.[r.sha256],
    });
  }
  return suggestSet(inputs);
}

export interface CandidateDisk { id: string; diskNo: number; sourceFilename: string | null; tosecName: string | null }
export interface CandidateTitle { gameId: string; title: string; disks: CandidateDisk[] }

/**
 * Up to 20 of the org's titles, excluding `exclude`, matching `q` against the
 * title, a disk's tosec_name, or the entitlement's source_filename -- or, for
 * an empty `q`, simply the 20 newest. Every returned title carries ALL of its
 * disks, not only the ones that matched: the caller is picking a whole title
 * to fold in, same as addDisksToSet does.
 *
 * `q` reaches ILIKE only through likePattern(), which escapes `%` and `_`
 * (src/lib/search-query.ts) so the caller's own text can never act as a
 * wildcard; every value below is a bound parameter or a drizzle column/table
 * reference, never a spliced string.
 */
export async function searchCandidates(orgId: string, q: string, exclude: string | null): Promise<CandidateTitle[]> {
  const db = getDb();
  const pattern = likePattern(q);

  const matches = pattern
    ? or(
        ilike(games.title, pattern),
        sql`exists (
          select 1 from ${disks}
          where ${disks.gameId} = ${games.id} and ${disks.orgId} = ${orgId}
          and (${disks.tosecName} ilike ${pattern} or exists (
            select 1 from ${entitlements}
            where ${entitlements.sha256} = ${disks.sha256} and ${entitlements.orgId} = ${orgId}
            and ${entitlements.sourceFilename} ilike ${pattern}
          ))
        )`,
      )
    : undefined;

  const titleRows = await db.select({ id: games.id, title: games.title })
    .from(games)
    .where(orgFilter(games, orgId, and(exclude ? ne(games.id, exclude) : undefined, matches)))
    .orderBy(desc(games.createdAt), asc(games.id))
    .limit(20);

  if (titleRows.length === 0) return [];

  const gameIds = titleRows.map((r) => r.id);
  const diskRows = await db.select({
    gameId: disks.gameId, id: disks.id, diskNo: disks.diskNo,
    tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename,
  })
    .from(disks)
    .leftJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(inArray(disks.gameId, gameIds), eq(disks.orgId, orgId)))
    .orderBy(asc(disks.diskNo));

  const byGame = new Map<string, CandidateDisk[]>();
  for (const d of diskRows) {
    const list = byGame.get(d.gameId) ?? [];
    list.push({ id: d.id, diskNo: d.diskNo, sourceFilename: d.sourceFilename ?? null, tosecName: d.tosecName });
    byGame.set(d.gameId, list);
  }
  return titleRows.map((t) => ({ gameId: t.id, title: t.title, disks: byGame.get(t.id) ?? [] }));
}
