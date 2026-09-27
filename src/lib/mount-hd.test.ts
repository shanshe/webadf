import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// setDesired and readDesired against a fake db that answers each query in
// call order and keeps every WHERE, so the HD gate is proven to sit IN the
// UPDATE (rendered back to SQL) -- the same no-read-before-write rule the
// track gate follows -- not merely inferred from the outcome.
let selects: unknown[][] = [];
let updates: unknown[][] = [];
const wheres: unknown[] = [];
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'leftJoin', 'innerJoin', 'set']) c[k] = () => c;
  c.where = (w: unknown) => { wheres.push(w); return c; };
  c.limit = () => Promise.resolve(result);
  c.returning = () => Promise.resolve(result);
  return c;
}
const fakeDb = {
  select: () => chain(selects.shift() ?? []),
  update: () => chain(updates.shift() ?? []),
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { setDesired, readDesired } = await import('./mount');
const render = (w: unknown) => new PgDialect().sqlToQuery(w as SQL).sql;

const HD = {
  id: 'disk-hd', sha256: 'a'.repeat(64), gameId: 'g1', diskNo: 1,
  sizeBytes: 1_802_240, imageFormat: 'adf', maxTrackBits: null,
};
const DD = { ...HD, id: 'disk-dd', sizeBytes: 901_120 };

beforeEach(() => { selects = []; updates = []; wheres.length = 0; });

describe('setDesired and HD (spec §4.3)', () => {
  it('gates an HD disk on plays_hd inside the UPDATE itself', async () => {
    selects = [[HD]];
    updates = [[{ version: 7 }]];
    expect(await setDesired('org-1', 'dev-1', HD.id)).toEqual({ ok: true, version: 7 });
    expect(render(wheres[1])).toContain('"devices"."plays_hd"');
  });

  it('does not gate a DD disk on plays_hd', async () => {
    selects = [[DD]];
    updates = [[{ version: 3 }]];
    expect(await setDesired('org-1', 'dev-1', DD.id)).toEqual({ ok: true, version: 3 });
    expect(render(wheres[1])).not.toContain('plays_hd');
  });

  it("refuses hd_unsupported for this org's board that cannot play HD", async () => {
    selects = [[HD], [{ id: 'dev-1' }]];
    updates = [[]];
    expect(await setDesired('org-1', 'dev-1', HD.id)).toEqual({ ok: false, reason: 'hd_unsupported' });
  });

  it("stays a plain not_found for a device that is not this org's", async () => {
    selects = [[HD], []];
    updates = [[]];
    expect(await setDesired('org-1', 'dev-x', HD.id)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('readDesired and HD (HD writes spec §5.3)', () => {
  const row = {
    version: 5, sha256: 'a'.repeat(64), diskId: 'disk-hd', gameId: 'g1', diskNo: 1,
    title: 'T', label: 'L', diskCount: 1,
    imageFormat: 'adf', sizeBytes: 1_802_240,
  };

  it("sends an HD disk's flag as the library has it", async () => {
    selects = [[{ ...row, writeProtected: false }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(false);
    selects = [[{ ...row, writeProtected: true }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(true);
  });

  it('still sends a disk whose row has gone missing as protected', async () => {
    selects = [[{ ...row, writeProtected: null }]];
    expect((await readDesired('dev-1'))?.desired?.writeProtected).toBe(true);
  });
});
