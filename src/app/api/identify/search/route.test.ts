import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireOrg = vi.fn(() => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }));
vi.mock('@/lib/session', () => ({ requireOrg: () => requireOrg() }));
const searchDemozoo = vi.fn();
vi.mock('@/lib/demozoo/queries', () => ({ searchDemozoo: (q: string) => searchDemozoo(q) }));
const searchTosec = vi.fn();
vi.mock('@/lib/tosec-search', () => ({ searchTosec: (q: string) => searchTosec(q) }));

const { GET } = await import('./route');

const get = (qs: string) => GET(new Request(`http://x/api/identify/search${qs}`));
const PROD = { id: 7, title: 'Wayfarer', releaseYear: 1992, types: ['Demo'], groups: ['Spaceballs'], url: 'u', screenshots: [] };
const REL = { key: 'workbench-v3-1-1993-commodore', name: 'Workbench v3.1 (1993)(Commodore)', title: 'Workbench v3.1', year: 1993, publisher: 'Commodore', diskCount: 6 };

beforeEach(() => {
  requireOrg.mockClear();
  searchDemozoo.mockReset().mockResolvedValue([PROD]);
  searchTosec.mockReset().mockResolvedValue([REL]);
});

describe('GET /api/identify/search', () => {
  it('answers from both catalogs by default, passing the raw query to each', async () => {
    const res = await get('?q=workbench');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ demozoo: [PROD], tosec: [REL] });
    expect(searchDemozoo).toHaveBeenCalledWith('workbench');
    expect(searchTosec).toHaveBeenCalledWith('workbench');
  });

  it('sources=tosec skips Demozoo entirely (a title the scans know is a game)', async () => {
    const res = await get('?q=workbench&sources=tosec');
    expect(await res.json()).toEqual({ demozoo: [], tosec: [REL] });
    expect(searchDemozoo).not.toHaveBeenCalled();
  });

  it('sources=demozoo skips TOSEC', async () => {
    const res = await get('?q=x&sources=demozoo');
    expect(await res.json()).toEqual({ demozoo: [PROD], tosec: [] });
    expect(searchTosec).not.toHaveBeenCalled();
  });

  it('sources=demozoo,tosec is both', async () => {
    expect(await (await get('?q=x&sources=demozoo,tosec')).json()).toEqual({ demozoo: [PROD], tosec: [REL] });
  });

  it.each(['bogus', '', 'tosec,bogus'])('an unknown sources value (%j) is 400 and searches nothing', async (s) => {
    const res = await get(`?q=x&sources=${s}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_sources' });
    expect(searchDemozoo).not.toHaveBeenCalled();
    expect(searchTosec).not.toHaveBeenCalled();
  });

  it('a missing q is an empty query, left to each search to answer []', async () => {
    await get('');
    expect(searchTosec).toHaveBeenCalledWith('');
    expect(searchDemozoo).toHaveBeenCalledWith('');
  });

  it('requires a session before searching', async () => {
    requireOrg.mockImplementationOnce(() => Promise.reject(new Error('unauthorised')));
    await expect(get('?q=x')).rejects.toThrow('unauthorised');
    expect(searchTosec).not.toHaveBeenCalled();
    expect(searchDemozoo).not.toHaveBeenCalled();
  });
});
