import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'org-1' }) }));
const devRow = vi.fn();
vi.mock('@/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => devRow() }) }) }) }),
}));
const readNextForDevices = vi.fn();
vi.mock('@/lib/next-disk', () => ({ readNextForDevices: (...a: unknown[]) => readNextForDevices(...a) }));
const setDesired = vi.fn();
vi.mock('@/lib/mount', () => ({ setDesired: (...a: unknown[]) => setDesired(...a) }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://t/api/devices/x/next', { method: 'POST' });
const D2 = { id: 'disk-2', diskNo: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  devRow.mockReturnValue([{ id: 'dev-1', desiredDiskId: 'disk-1', mountedDiskId: 'disk-1', trackMaxBytes: 14336, playsHd: true }]);
  readNextForDevices.mockResolvedValue(new Map([['dev-1', { kind: 'disk', disk: D2, diskCount: 3, wraps: false }]]));
  setDesired.mockResolvedValue({ ok: true, version: 7 });
});

describe('POST /api/devices/[id]/next', () => {
  it('mounts the next disk with the session org', async () => {
    const { POST } = await import('./route');
    const res = await POST(req(), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'mounting', diskNo: 2, diskCount: 3 });
    expect(setDesired).toHaveBeenCalledWith('org-1', 'dev-1', 'disk-2');
    expect(readNextForDevices.mock.calls[0][0]).toBe('org-1');
  });
  it('is 404 for a board that is not this org\'s', async () => {
    devRow.mockReturnValue([]);
    const { POST } = await import('./route');
    expect((await POST(req(), ctx('dev-9'))).status).toBe(404);
    expect(setDesired).not.toHaveBeenCalled();
  });
  it('answers single without mounting anything', async () => {
    readNextForDevices.mockResolvedValue(new Map([['dev-1', { kind: 'single' }]]));
    const { POST } = await import('./route');
    expect(await (await POST(req(), ctx('dev-1'))).json()).toEqual({ outcome: 'single' });
    expect(setDesired).not.toHaveBeenCalled();
  });
  it('passes a refusal through as 409', async () => {
    setDesired.mockResolvedValue({ ok: false, reason: 'hd_unsupported' });
    const { POST } = await import('./route');
    const res = await POST(req(), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('hd_unsupported');
  });
});
