import { describe, it, expect } from 'vitest';
import { planAddDisks, planReorder, planMoveOut, PlanError, type SetDisk } from './disk-set';

const d = (id: string, gameId: string, diskNo: number): SetDisk => ({ id, gameId, diskNo });

describe('planAddDisks', () => {
  it('appends picked lone disks after the set, in pick order, and empties their titles', () => {
    const set = { gameId: 'S', disks: [d('i', 'S', 1), d('w', 'S', 2)] };
    const fonts = d('f', 'F', 1), locale = d('l', 'L', 1);
    const p = planAddDisks(set, [locale, fonts], [locale, fonts], []);
    expect(p.renumber).toEqual([{ diskId: 'l', gameId: 'S', diskNo: 3 }, { diskId: 'f', gameId: 'S', diskNo: 4 }]);
    expect(p.emptiedGameIds.sort()).toEqual(['F', 'L']);
  });
  it('brings every disk of a picked multi-disk title, in its own order (Review Focus 5)', () => {
    const set = { gameId: 'S', disks: [d('a', 'S', 1)] };
    const t2 = d('t2', 'T', 2), t1 = d('t1', 'T', 1);
    const p = planAddDisks(set, [t2], [t2, t1], []);
    expect(p.renumber).toEqual([{ diskId: 't1', gameId: 'S', diskNo: 2 }, { diskId: 't2', gameId: 'S', diskNo: 3 }]);
    expect(p.emptiedGameIds).toEqual(['T']);
  });
  it('moves a board holding a moved disk to the new game and number, never its disk id (Review Focus 1)', () => {
    const set = { gameId: 'S', disks: [d('a', 'S', 1)] };
    const f = d('f', 'F', 1);
    const p = planAddDisks(set, [f], [f], [{ id: 'dev', desiredDiskId: 'f', mountedDiskId: 'f' }]);
    expect(p.devices).toEqual([{ deviceId: 'dev', desired: { gameId: 'S', diskNo: 2 }, mounted: { gameId: 'S', diskNo: 2 } }]);
  });
  it('refuses a disk already in the set, and an empty pick', () => {
    const set = { gameId: 'S', disks: [d('a', 'S', 1)] };
    expect(() => planAddDisks(set, [d('a', 'S', 1)], [d('a', 'S', 1)], [])).toThrow(PlanError);
    expect(() => planAddDisks(set, [], [], [])).toThrow(PlanError);
  });
});

describe('planReorder', () => {
  const set = { gameId: 'S', disks: [d('a', 'S', 1), d('b', 'S', 2), d('c', 'S', 3)] };
  it('renumbers 1..N in the given order', () => {
    expect(planReorder(set, ['c', 'a', 'b'], []).renumber).toEqual([
      { diskId: 'c', gameId: 'S', diskNo: 1 }, { diskId: 'a', gameId: 'S', diskNo: 2 }, { diskId: 'b', gameId: 'S', diskNo: 3 },
    ]);
  });
  it.each([[['a', 'b']], [['a', 'b', 'c', 'x']], [['a', 'a', 'b']]])('refuses a stale list %j (Review Focus 4)', (ids) => {
    expect(() => planReorder(set, ids as string[], [])).toThrowError(new PlanError('stale_order'));
  });
});

describe('planMoveOut', () => {
  it('makes the disk number 1 of its new title and closes the gap in the old one', () => {
    const b = d('b', 'S', 2);
    const p = planMoveOut(b, 'N', [d('a', 'S', 1), d('c', 'S', 3)], []);
    expect(p.renumber).toEqual([
      { diskId: 'b', gameId: 'N', diskNo: 1 }, { diskId: 'a', gameId: 'S', diskNo: 1 }, { diskId: 'c', gameId: 'S', diskNo: 2 },
    ]);
    expect(p.emptiedGameIds).toEqual([]);
  });
  it('empties the old title when it was the last disk', () => {
    expect(planMoveOut(d('a', 'S', 1), 'N', [], []).emptiedGameIds).toEqual(['S']);
  });
});
