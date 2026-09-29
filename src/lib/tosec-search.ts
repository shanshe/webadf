/**
 * "Find on TOSEC": the title page's search over tosec_entries, returning
 * RELEASES, not disks. A four-disk release is four rows in tosec_entries (one
 * per image, plus any [a]/[b] alternate dumps); a person picking what their
 * title is wants the release once, with its disk count.
 *
 * GLOBAL, like the table itself: TOSEC is public catalog data every tenant
 * searches alike, and nothing here reads or writes an org's own rows.
 *
 * The grouping runs in Postgres, not here, so LIMIT counts releases: grouping
 * a LIMITed row list in JS would let one large set fill the page and cut the
 * last release's disks short. No trigram index -- ILIKE over ~56k rows is
 * fast enough for a search fired on submit, not per keystroke.
 */
import { and, asc, ilike, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { tosecEntries } from '@/db/schema/tosec';
import { escapeLike, normalizeQuery } from '@/lib/search-query';

export const TOSEC_SEARCH_LIMIT = 10;

export interface TosecRelease {
  /** Stable, URL/test-id safe: derived from `name`, unique within one result. */
  key: string;
  /** The TOSEC game name without its "(Disk N of M)" clause or [flags]. */
  name: string;
  title: string;
  year: number | null;
  publisher: string | null;
  diskCount: number;
}

// Constant SQL literals, deliberately NOT parameters: the same expression
// appears in SELECT, GROUP BY and ORDER BY, and Postgres only accepts the
// select-list expression as grouped when it is textually the same one --
// three separate $n parameters would make them three different expressions.
// Neither contains any input.
const DISK_CLAUSE = sql.raw(String.raw`'\s*\(Disk \d+( of \d+)?\)'`);
const FLAG = sql.raw(String.raw`'\s*\[[^\]]*\]'`);
const baseName = sql<string>`regexp_replace(regexp_replace(${tosecEntries.gameName}, ${DISK_CLAUSE}, '', 'gi'), ${FLAG}, '', 'g')`;

/** Lowercase, alphanumerics and single dashes: safe in a data-testid or a URL. */
export function tosecKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function searchTosec(raw: string): Promise<TosecRelease[]> {
  const q = normalizeQuery(raw);
  // Same floor as searchDemozoo: the combined box sends one query to both,
  // and a single character matches most of the table.
  if (q.length < 2) return [];
  const escaped = escapeLike(q);
  const infix = `%${escaped}%`;

  const rank = sql`(case when ${tosecEntries.title} ilike ${escaped} then 0
                         when ${tosecEntries.title} ilike ${`${escaped}%`} then 1
                         else 2 end)`;

  const rows = await getDb().select({
    base: baseName,
    title: tosecEntries.title,
    year: tosecEntries.year,
    publisher: tosecEntries.publisher,
    // The DAT's own "of M" when any disk carries it; otherwise how many
    // distinct disk numbers exist; a release with neither is one disk.
    // count() is bigint, which the driver may hand back as a string.
    diskCount: sql<number | string>`coalesce(max(${tosecEntries.diskCount}), nullif(count(distinct ${tosecEntries.diskNo}), 0), 1)`,
  })
    .from(tosecEntries)
    .where(and(or(ilike(tosecEntries.title, infix), ilike(tosecEntries.gameName, infix))))
    .groupBy(tosecEntries.title, tosecEntries.year, tosecEntries.publisher, baseName)
    // Total ahead of LIMIT: (title, year, publisher, base) is the group key,
    // so ending on it leaves no two rows tied.
    .orderBy(rank, sql`min(${tosecEntries.sortTitle})`, sql`${tosecEntries.year} asc nulls last`,
      asc(tosecEntries.title), sql`${tosecEntries.publisher} asc nulls last`, baseName)
    .limit(TOSEC_SEARCH_LIMIT);

  const seen = new Set<string>();
  return rows.map((r) => {
    const base = tosecKey(r.base) || 'release';
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base}-${n}`;
    seen.add(key);
    return {
      key,
      name: r.base,
      title: r.title,
      year: r.year,
      // TOSEC's "-" means the publisher is unknown, not a publisher called "-".
      publisher: r.publisher === '-' ? null : r.publisher,
      diskCount: Number(r.diskCount),
    };
  });
}
