import { requireOrg } from '@/lib/session';
import { searchDemozoo } from '@/lib/demozoo/queries';
import { searchTosec } from '@/lib/tosec-search';

export const maxDuration = 60;

const SOURCES = ['demozoo', 'tosec'] as const;
type Source = (typeof SOURCES)[number];

/**
 * The title page's one "Find on Demozoo or TOSEC" box: both local catalogs,
 * searched together. Behind a session like every library route, though both
 * catalogs are global public data; neither search reaches the internet.
 *
 * `sources` (comma-separated, default both) narrows it: a title the scans
 * know is a game passes `sources=tosec`, since Demozoo is never offered for
 * a game (Demozoo spec §5.3.1). A skipped source answers [] rather than
 * being absent, so the client reads one shape. An unknown name is a 400, not
 * a silent "both": a typo must not quietly bring Demozoo back for a game.
 *
 * /api/demozoo/search stays as it was, for anything still calling it.
 */
export async function GET(request: Request) {
  await requireOrg();
  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';

  const raw = params.get('sources');
  const wanted = raw === null ? [...SOURCES] : raw.split(',').map((s) => s.trim());
  if (wanted.length === 0 || !wanted.every((s): s is Source => (SOURCES as readonly string[]).includes(s))) {
    return Response.json({ error: 'invalid_sources' }, { status: 400 });
  }

  const [demozoo, tosec] = await Promise.all([
    wanted.includes('demozoo') ? searchDemozoo(q) : [],
    wanted.includes('tosec') ? searchTosec(q) : [],
  ]);
  return Response.json({ demozoo, tosec });
}
