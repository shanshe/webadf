import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const searchCandidates = vi.fn();
vi.mock('@/lib/disk-set-search', () => ({ searchCandidates: (...a: unknown[]) => searchCandidates(...a) }));

const { GET } = await import('./route');

const get = (qs: string) => new Request(`http://x/api/disk-sets/candidates${qs}`);

beforeEach(() => { searchCandidates.mockReset(); });

describe('GET /api/disk-sets/candidates', () => {
  it('calls the store with the session org, q and exclude, and returns its titles', async () => {
    const titles = [{ gameId: 'g1', title: 'Lemmings', disks: [{ id: 'd1', diskNo: 1, sourceFilename: 'L.adf', tosecName: null }] }];
    searchCandidates.mockResolvedValue(titles);
    const res = await GET(get('?q=lem&exclude=G-self'));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', 'lem', 'G-self');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ titles });
  });

  it('an absent q is the empty string, not "null"', async () => {
    searchCandidates.mockResolvedValue([]);
    await GET(get('?exclude=G-self'));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', '', 'G-self');
  });

  it('an absent or blank exclude is null', async () => {
    searchCandidates.mockResolvedValue([]);
    await GET(get('?q=lem'));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', 'lem', null);

    searchCandidates.mockClear();
    await GET(get('?q=lem&exclude='));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', 'lem', null);
  });
});
