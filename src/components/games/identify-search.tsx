'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Candidate, type ProductionLite } from './demozoo-actions';

// Redeclared, not imported: @/lib/tosec-search pulls the database into the
// browser bundle (the same reason demozoo-actions.tsx redeclares its types).
export interface TosecReleaseLite {
  key: string; name: string; title: string; year: number | null; publisher: string | null; diskCount: number;
}

type Sources = 'all' | 'tosec';

const TAG = 'mb-0.5 mr-2 inline-block rounded-full px-2 py-px align-middle text-[10.5px] font-semibold uppercase tracking-wide';

function Tag({ source }: { source: 'demozoo' | 'tosec' }) {
  return (
    <span data-testid={`identify-search-result-${source}`} className={TAG}
      style={{ background: 'var(--hairline)', color: 'var(--muted)' }}>
      {source === 'demozoo' ? 'Demozoo' : 'TOSEC'}
    </span>
  );
}

const disks = (n: number) => `${n} ${n === 1 ? 'disk' : 'disks'}`;

/**
 * A TOSEC release. "Use these details" is an ordinary identity edit through
 * PATCH /api/games/[id] -- exactly what typing them into the edit form would
 * do, so the title is stamped 'human' and no later scan overwrites it. Only
 * what TOSEC actually knows is sent: an unknown year or publisher leaves the
 * title's own value alone rather than erasing it.
 */
function TosecRow({ gameId, r }: { gameId: string; r: TosecReleaseLite }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function use() {
    setBusy(true);
    try {
      const body: Record<string, string | number> = { title: r.title };
      if (r.year !== null) body.year = r.year;
      if (r.publisher !== null) body.publisher = r.publisher;
      const res = await fetch(`/api/games/${gameId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { toast.error('Could not set the details'); return; }
      toast.success('Details set from TOSEC');
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="tosec-search-result" data-key={r.key}
        className="flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center" style={{ background: 'var(--glass-strong)' }}>
      <div className="min-w-0 flex-1">
        <Tag source="tosec" />
        <span className="break-words font-semibold">{r.name}</span>
        <div className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
          {[r.year, r.publisher, disks(r.diskCount)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <button type="button" data-testid={`tosec-use-${r.key}`} disabled={busy} onClick={use}
        className="min-h-11 shrink-0 rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50 sm:min-h-0"
        style={{ background: 'var(--primary-action)' }}>
        Use these details
      </button>
    </li>
  );
}

/**
 * The title page's one search box over both local catalogs. `sources="tosec"`
 * is for a title the scans know is a game: Demozoo is never offered for a
 * game (Demozoo spec §5.3.1), and the server is asked not to search it at all.
 *
 * The form and input keep their original demozoo-search test ids: this box
 * replaced "Find on Demozoo" in place.
 */
export function IdentifySearch({ gameId, sources }: { gameId: string; sources: Sources }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ demozoo: ProductionLite[]; tosec: TosecReleaseLite[] } | null>(null);
  const [searching, setSearching] = useState(false);
  // The previous search's in-flight request, so a resubmit aborts it rather
  // than letting an older response land after a newer one and overwrite it.
  const searchAbortRef = useRef<AbortController | null>(null);
  const label = sources === 'tosec' ? 'Find on TOSEC' : 'Find on Demozoo or TOSEC';

  async function search(e: React.FormEvent) {
    e.preventDefault();
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    try {
      const qs = new URLSearchParams({ q });
      if (sources === 'tosec') qs.set('sources', 'tosec');
      const res = await fetch(`/api/identify/search?${qs}`, { signal: controller.signal });
      if (!res.ok) {
        // Leave the previous results on screen: a server error is not the
        // same fact as "nothing matched".
        if (!controller.signal.aborted) toast.error('Could not search');
        return;
      }
      const json = await res.json();
      setResults({ demozoo: json.demozoo ?? [], tosec: json.tosec ?? [] });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast.error('Could not reach the server');
    } finally {
      // Only the still-current request clears the busy state.
      if (searchAbortRef.current === controller) setSearching(false);
    }
  }

  const empty = results && results.demozoo.length === 0 && results.tosec.length === 0;

  return (
    <div data-testid="identify-search">
      <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row" data-testid="demozoo-search">
        <input data-testid="demozoo-search-input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={label} aria-label={label}
          className="min-h-11 min-w-0 flex-1 rounded-full px-4 py-1.5 text-[13px] sm:min-h-0" style={{ background: 'var(--input-bg)' }} />
        <button type="submit" disabled={searching} data-testid="identify-search-submit"
          className="min-h-11 rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50 sm:min-h-0" style={{ color: 'var(--muted)' }}>
          Search
        </button>
      </form>
      {results && (
        <ul className="mt-3 flex flex-col gap-2" data-testid="identify-search-results">
          {empty && (
            <li className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
              {sources === 'tosec' ? 'No TOSEC release with that title.' : 'Nothing on Demozoo or TOSEC with that title.'}
            </li>
          )}
          {results.demozoo.map((p) => (
            <Candidate key={`d${p.id}`} gameId={gameId} p={p} allowDismiss={false} testId="demozoo-search-result" tag={<Tag source="demozoo" />} />
          ))}
          {results.tosec.map((r) => <TosecRow key={`t${r.key}`} gameId={gameId} r={r} />)}
        </ul>
      )}
    </div>
  );
}
