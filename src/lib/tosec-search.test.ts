// Fake db in the style of disk-set-search.test.ts: the one select is captured
// with its WHERE / GROUP BY / ORDER BY kept as REAL drizzle SQL, so the
// rendered statement (grouping, escaping, the limit) is asserted on its own
// shape rather than trusted from the TypeScript that built it. The grouping
// itself runs in Postgres; what is testable here is that the statement asks
// for it, and that the aggregate rows it returns become the right releases.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

type Sel = { fields: Record<string, unknown>; where?: SQL; group: SQL[]; order: SQL[]; limit?: number };
let selects: Sel[];
let rows: unknown[];

const fakeDb = {
  select: (fields: Record<string, unknown>) => {
    const q: Sel = { fields, group: [], order: [] };
    const chain = {
      from: () => chain,
      where: (w: SQL) => { q.where = w; return chain; },
      groupBy: (...g: SQL[]) => { q.group.push(...g); return chain; },
      orderBy: (...o: SQL[]) => { q.order.push(...o); return chain; },
      limit: (n: number) => { q.limit = n; return chain; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        selects.push(q);
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  },
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { searchTosec, tosecKey, tosecBaseName, baseNameSql, DISK_TAIL_PATTERN, FLAG_PATTERN, TOSEC_SEARCH_LIMIT } = await import('./tosec-search');

const dialect = new PgDialect();
// Columns and SQL alike: a bare column is wrapped so it renders qualified.
const render = (s: unknown) => dialect.sqlToQuery(sql`${s}`);

beforeEach(() => { selects = []; rows = []; });

describe('searchTosec', () => {
  it.each(['', '   ', '\t', 'a'])('returns [] without querying for %j', async (q) => {
    expect(await searchTosec(q)).toEqual([]);
    expect(selects).toHaveLength(0);
  });

  it('matches title OR game_name case-insensitively, with the query as a parameter', async () => {
    await searchTosec('  Workbench  ');
    expect(selects).toHaveLength(1);
    const where = render(selects[0].where!);
    expect(where.sql).toMatch(/"tosec_entries"\."title" ilike \$\d+/);
    expect(where.sql).toMatch(/"tosec_entries"\."game_name" ilike \$\d+/);
    expect(where.sql).toMatch(/ or /);
    expect(where.sql).not.toContain('Workbench');
    expect(where.params).toEqual(expect.arrayContaining(['%Workbench%']));
  });

  it('escapes %, _ and backslash so they match literally', async () => {
    await searchTosec('100%_\\x');
    const where = render(selects[0].where!);
    expect(where.params).toEqual(expect.arrayContaining(['%100\\%\\_\\\\x%']));
  });

  it('groups by release: title, year, publisher and the game name with its disk clause and flags removed', async () => {
    await searchTosec('workbench');
    const group = selects[0].group.map((g) => render(g).sql).join(', ');
    expect(group).toContain('"tosec_entries"."title"');
    expect(group).toContain('"tosec_entries"."year"');
    expect(group).toContain('"tosec_entries"."publisher"');
    // The base name: cut at "(Disk N of M)" and every [flag] stripped, so the
    // disks of one release (and its [a] alternates) fold into one row. The
    // literals are exactly the patterns tosecBaseName uses, so its tests
    // below are tests of this expression.
    expect(group).toContain(
      `regexp_replace(regexp_replace("tosec_entries"."game_name", '${DISK_TAIL_PATTERN}', '', 'i'), '${FLAG_PATTERN}', '', 'g')`);
  });

  it('asks for at most 10 releases, in a total order', async () => {
    await searchTosec('workbench');
    expect(selects[0].limit).toBe(TOSEC_SEARCH_LIMIT);
    expect(TOSEC_SEARCH_LIMIT).toBe(10);
    const order = selects[0].order.map((o) => render(o).sql).join(', ');
    // Exact title first, then prefix, then the rest; the base name last so
    // LIMIT never cuts between equal rows arbitrarily.
    expect(order).toMatch(/^\(case when .* then 0\s+when .* then 1\s+else 2 end\)/);
    expect(order).toMatch(/regexp_replace.*$/);
  });

  it('turns each aggregate row into one release', async () => {
    rows = [
      { base: 'Graphics Workbench v1.0 (1995)(Macks Conspiracy)(AGA)', title: 'Graphics Workbench v1.0', year: 1995, publisher: 'Macks Conspiracy', diskCount: 4 },
      { base: 'Workbench Tutorial (19xx)(Amiga Legal Emulation)', title: 'Workbench Tutorial', year: null, publisher: null, diskCount: 1 },
      { base: 'A500 Workbench (1987)(-)', title: 'A500 Workbench', year: 1987, publisher: '-', diskCount: 1 },
    ];
    expect(await searchTosec('workbench')).toEqual([
      { key: 'graphics-workbench-v1-0-1995-macks-conspiracy-aga', name: 'Graphics Workbench v1.0 (1995)(Macks Conspiracy)(AGA)',
        title: 'Graphics Workbench v1.0', year: 1995, publisher: 'Macks Conspiracy', diskCount: 4 },
      { key: 'workbench-tutorial-19xx-amiga-legal-emulation', name: 'Workbench Tutorial (19xx)(Amiga Legal Emulation)',
        title: 'Workbench Tutorial', year: null, publisher: null, diskCount: 1 },
      // TOSEC writes "-" for an unknown publisher: that is no publisher.
      { key: 'a500-workbench-1987', name: 'A500 Workbench (1987)(-)', title: 'A500 Workbench', year: 1987, publisher: null, diskCount: 1 },
    ]);
  });

  it('never returns two releases with the same key', async () => {
    rows = [
      { base: 'X v1.0', title: 'X v1.0', year: null, publisher: null, diskCount: 1 },
      { base: 'X v1-0', title: 'X v1-0', year: null, publisher: null, diskCount: 1 },
    ];
    const keys = (await searchTosec('x v1')).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('reads the disk count as a number even when the driver hands back a string', async () => {
    rows = [{ base: 'Y (1990)(Z)', title: 'Y', year: 1990, publisher: 'Z', diskCount: '3' }];
    expect((await searchTosec('yy'))[0].diskCount).toBe(3);
  });
});

describe('tosecKey', () => {
  it('is lowercase, alphanumeric and dashes only', () => {
    expect(tosecKey('Lemmings 2 - The Tribes (1993)(Psygnosis)')).toBe('lemmings-2-the-tribes-1993-psygnosis');
  });
});

describe('tosecBaseName (the grouping key, mirrored from the SQL)', () => {
  const same = (names: string[]) => new Set(names.map(tosecBaseName));

  it('folds disks with a per-disk sub-label after the disk clause into one release', () => {
    const keys = same([
      'Workbench v3.1 (1994)(Commodore)(Disk 1 of 6)(Install)',
      'Workbench v3.1 (1994)(Commodore)(Disk 2 of 6)(Workbench)',
      'Workbench v3.1 (1994)(Commodore)(Disk 3 of 6)(Extras)',
      'Workbench v3.1 (1994)(Commodore)(Disk 4 of 6)(Save Disk)',
      'Workbench v3.1 (1994)(Commodore)(Disk 5 of 6)(Program)[a]',
      'Workbench v3.1 (1994)(Commodore)(Disk 6 of 6)(Data)[cr XYZ]',
    ]);
    expect([...keys]).toEqual(['Workbench v3.1 (1994)(Commodore)']);
  });

  it('folds numbered disks and their [flag] alternates', () => {
    expect([...same([
      'Lemmings (1991)(Psygnosis)(Disk 1 of 2)',
      'Lemmings (1991)(Psygnosis)(Disk 1 of 2)[a]',
      'Lemmings (1991)(Psygnosis)(Disk 2 of 2)[cr Skid Row]',
    ])]).toEqual(['Lemmings (1991)(Psygnosis)']);
  });

  it('folds letter disks, with and without "of"', () => {
    expect([...same([
      'Game (1990)(Pub)(Disk A)',
      'Game (1990)(Pub)(Disk B)[a]',
      'Game (1990)(Pub)(Disk A of B)',
    ])]).toEqual(['Game (1990)(Pub)']);
  });

  it('folds a disk clause with no "of M"', () => {
    expect(tosecBaseName('Game (1990)(Pub)(Disk 3)(Level Data)')).toBe('Game (1990)(Pub)');
  });

  it('leaves a name without a disk clause as before: only [flags] removed', () => {
    expect(tosecBaseName('Graphics Workbench v1.0 (1995)(Macks Conspiracy)(AGA)[a][cr X]'))
      .toBe('Graphics Workbench v1.0 (1995)(Macks Conspiracy)(AGA)');
    expect(tosecBaseName('Save Disk Utility (1990)(Pub)')).toBe('Save Disk Utility (1990)(Pub)');
    // "(Disk" must open a disk clause; a word inside another clause is not one.
    expect(tosecBaseName('Data (1990)(Disk Masters)')).toBe('Data (1990)(Disk Masters)');
  });

  it('keeps two different releases apart', () => {
    expect(same(['X (1990)(Pub)(Disk 1 of 2)', 'X (1991)(Pub)(Disk 1 of 2)']).size).toBe(2);
  });

  it('is the expression the SQL renders, over any input', () => {
    const q = render(baseNameSql(sql`${'Some Name (Disk 1 of 2)'}`));
    // The user-side text stays a bound parameter; the patterns are literals.
    expect(q.params).toEqual(['Some Name (Disk 1 of 2)']);
    expect(q.sql).toBe(`regexp_replace(regexp_replace($1, '${DISK_TAIL_PATTERN}', '', 'i'), '${FLAG_PATTERN}', '', 'g')`);
  });
});
