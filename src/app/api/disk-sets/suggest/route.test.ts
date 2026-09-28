import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const suggestFromUpload = vi.fn();
vi.mock('@/lib/disk-set-search', () => ({ suggestFromUpload: (...a: unknown[]) => suggestFromUpload(...a) }));

const { POST } = await import('./route');

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-09-28T12:00:00Z');
const req = (body: unknown) => new Request('http://x/api/disk-sets/suggest', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => {
  suggestFromUpload.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('POST /api/disk-sets/suggest', () => {
  it('calls the store with the session org, the parsed hashes/since/paths, and returns its suggestion', async () => {
    const suggestion = { name: 'AmigaOS set', disks: [{ diskId: 'd1', gameId: 'g1', label: 'Workbench', ticked: true }] };
    suggestFromUpload.mockResolvedValue(suggestion);
    const since = '2026-09-28T11:00:00Z';
    const res = await POST(req({ sha256s: [SHA], since, paths: { [SHA]: 'sub/A.adf' } }));

    expect(suggestFromUpload).toHaveBeenCalledTimes(1);
    const [orgId, shas, sinceArg, paths] = suggestFromUpload.mock.calls[0];
    expect(orgId).toBe('org-1');
    expect(shas).toEqual([SHA]);
    expect(sinceArg).toBeInstanceOf(Date);
    expect(sinceArg.getTime()).toBe(new Date(since).getTime());
    expect(paths).toEqual({ [SHA]: 'sub/A.adf' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion });
  });

  it('passes undefined paths when none is given', async () => {
    suggestFromUpload.mockResolvedValue(null);
    await POST(req({ sha256s: [SHA], since: '2026-09-28T11:00:00Z' }));
    expect(suggestFromUpload.mock.calls[0][3]).toBeUndefined();
  });

  it('more than 32 sha256s is 400 and never reaches the store', async () => {
    const shas = Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    const res = await POST(req({ sha256s: shas, since: '2026-09-28T11:00:00Z' }));
    expect(res.status).toBe(400);
    expect(suggestFromUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', '{'],
    ['empty hashes', { sha256s: [], since: '2026-09-28T11:00:00Z' }],
    ['a hash of the wrong shape', { sha256s: ['not-a-sha'], since: '2026-09-28T11:00:00Z' }],
    ['missing since', { sha256s: [SHA] }],
    ['a non-ISO since', { sha256s: [SHA], since: '28 Sep 2026' }],
    // z.iso.datetime()'s default requires the 'Z'/offset form; a bare
    // local-time string is exactly the loosely-parsed shape the controller
    // ruling on `since` is there to keep out.
    ['an offset-less since Date() would still parse', { sha256s: [SHA], since: '2026-09-28T11:00:00' }],
    ['wrong type', { sha256s: SHA, since: '2026-09-28T11:00:00Z' }],
  ])('a malformed body (%s) is 400 and never reaches the store', async (_n, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(suggestFromUpload).not.toHaveBeenCalled();
  });

  it('a since more than 24h old is refused with 400, without reaching the store', async () => {
    const since = new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1).toISOString();
    const res = await POST(req({ sha256s: [SHA], since }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'since_too_old' });
    expect(suggestFromUpload).not.toHaveBeenCalled();
  });

  it('a since exactly at the 24h boundary is accepted', async () => {
    suggestFromUpload.mockResolvedValue(null);
    const since = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const res = await POST(req({ sha256s: [SHA], since }));
    expect(res.status).toBe(200);
    expect(suggestFromUpload).toHaveBeenCalled();
  });
});
