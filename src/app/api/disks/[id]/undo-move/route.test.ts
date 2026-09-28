import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const undoMove = vi.fn();
vi.mock('@/lib/disk-set-store', async () => {
  class NotFound extends Error {}
  return { undoMove: (...a: unknown[]) => undoMove(...a), NotFound };
});

const { POST } = await import('./route');
const { NotFound } = await import('@/lib/disk-set-store');
const { PlanError } = await import('@/lib/disk-set');

const snapshot = {
  diskIds: ['s1', 's2'], title: 'Lemmings', sortTitle: 'lemmings', year: 1991, publisher: 'Psygnosis',
  metadataSource: 'tosec', hadExtras: true,
};
const ctx = { params: Promise.resolve({ id: 's1' }) };
const req = (body: unknown) => new Request('http://x/api/disks/s1/undo-move', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => { undoMove.mockReset(); });

describe('POST /api/disks/[id]/undo-move', () => {
  it('calls the store with the session org and the parsed snapshot; 200 with the recreated title', async () => {
    undoMove.mockResolvedValue({ gameId: 'NEW' });
    const res = await POST(req({ snapshot }), ctx);
    expect(undoMove).toHaveBeenCalledWith('org-1', snapshot);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gameId: 'NEW' });
  });

  it('accepts null year, publisher and metadataSource', async () => {
    undoMove.mockResolvedValue({ gameId: 'NEW' });
    const s = { ...snapshot, year: null, publisher: null, metadataSource: null };
    const res = await POST(req({ snapshot: s }), ctx);
    expect(res.status).toBe(200);
    expect(undoMove).toHaveBeenCalledWith('org-1', s);
  });

  it('NotFound is 404', async () => {
    undoMove.mockRejectedValue(new NotFound());
    const res = await POST(req({ snapshot }), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('a stale snapshot (stale_undo) is 409', async () => {
    undoMove.mockRejectedValue(new PlanError('stale_undo'));
    const res = await POST(req({ snapshot }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale_undo' });
  });

  it.each([
    ['not json', '{'],
    ['no snapshot', {}],
    ['no disks', { snapshot: { ...snapshot, diskIds: [] } }],
    ['duplicate disks', { snapshot: { ...snapshot, diskIds: ['s1', 's1'] } }],
    ['empty title', { snapshot: { ...snapshot, title: '' } }],
    ['year as text', { snapshot: { ...snapshot, year: '1991' } }],
    ['path disk not in the snapshot', { snapshot: { ...snapshot, diskIds: ['s2'] } }],
  ])('a malformed body (%s) is 400', async (_n, body) => {
    const res = await POST(req(body), ctx);
    expect(res.status).toBe(400);
    expect(undoMove).not.toHaveBeenCalled();
  });
});
