/**
 * The pure decisions behind the title page's "Find on Demozoo or TOSEC" box,
 * kept free of React and of the database so they can be unit-tested and
 * imported into the browser bundle alike.
 */
import { normalizeQuery } from '@/lib/search-query';

/** Same floor as the server's searchTosec / searchDemozoo. */
export const MIN_QUERY_LEN = 2;

export function queryTooShort(raw: string): boolean {
  return normalizeQuery(raw).length < MIN_QUERY_LEN;
}

/**
 * "Use these details" replaces the title's identity AS A WHOLE with the
 * release's: what TOSEC does not know (no year, an unknown publisher) is sent
 * as null so the old value is cleared, not left behind to mix with the new
 * title. PATCH /api/games/[id] accepts null for both.
 */
export function tosecApplyBody(r: { title: string; year: number | null; publisher: string | null }) {
  return { title: r.title, year: r.year, publisher: r.publisher };
}

/**
 * The toast after the PATCH. The route answers `{ id, changed: Group[] }`,
 * and `changed: []` when the title already had exactly these details -- then
 * nothing was set, and saying so would be false.
 */
export function appliedMessage(json: unknown): { kind: 'success' | 'info'; text: string } {
  const changed = (json as { changed?: unknown } | null)?.changed;
  if (Array.isArray(changed) && changed.length === 0) {
    return { kind: 'info', text: 'This title already has these details' };
  }
  return { kind: 'success', text: 'Details set from TOSEC' };
}

/** What a screen reader hears once a search lands. */
export function resultsAnnouncement(demozoo: number, tosec: number, sources: 'all' | 'tosec'): string {
  const n = demozoo + tosec;
  if (n === 0) return sources === 'tosec' ? 'No TOSEC release with that title.' : 'Nothing on Demozoo or TOSEC with that title.';
  return `${n} ${n === 1 ? 'result' : 'results'}`;
}
