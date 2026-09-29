import { describe, it, expect } from 'vitest';
import type { Active, ClientRect, DroppableContainer, UniqueIdentifier } from '@dnd-kit/core';
import { collectionCollisionDetection, collectionGridCollisionDetection } from './collection-provider';

// A 3-card row like the collection grid at 1280: 180x200 slots, 16 px gutters.
const rect = (left: number, top: number, width = 180, height = 200): ClientRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height });
const row: Record<string, ClientRect> = {
  a: rect(0, 0), b: rect(196, 0), c: rect(392, 0),
  // A rail row, well to the left of the grid.
  rail: rect(-300, 0, 200, 30),
};

function args(activeType: 'game' | 'collection', pointer: { x: number; y: number } | null, slots: Record<string, ClientRect> = row) {
  const containers = Object.keys(slots).map((id) => ({
    id: id as UniqueIdentifier,
    key: id,
    data: { current: { type: id === 'rail' ? 'collection' : 'game', id } },
    disabled: false,
    node: { current: null },
    rect: { current: slots[id] },
  })) as unknown as DroppableContainer[];
  const active = { id: activeType === 'game' ? 'a' : 'rail', data: { current: { type: activeType } }, rect: { current: { initial: null, translated: null } } } as unknown as Active;
  return {
    active,
    collisionRect: rect(pointer?.x ?? 0, pointer?.y ?? 0, 10, 10),
    droppableRects: new Map(Object.entries(slots)) as Map<UniqueIdentifier, ClientRect>,
    droppableContainers: containers,
    pointerCoordinates: pointer,
  };
}

const ids = (c: ReturnType<typeof collectionGridCollisionDetection>) => c.map((x) => x.id);

describe('collectionGridCollisionDetection', () => {
  it('on a card: the same answer as the plain detection, with the zone', () => {
    const got = collectionGridCollisionDetection(args('game', { x: 392 + 90, y: 100 }));
    expect(ids(got)).toEqual(['c']);
    expect(got[0].data?.zone).toBe('centre');
  });

  it('in the gutter between B and C: the nearer card, as its edge', () => {
    // x 376..392 is the gutter. At 380, B's middle (286) is 94 px away and C's (482) 102.
    const nearB = collectionGridCollisionDetection(args('game', { x: 380, y: 100 }));
    expect(ids(nearB)).toEqual(['b']);
    expect(nearB[0].data?.zone).toBe('edge');
    expect(nearB[0].data?.pointer).toEqual({ x: 380, y: 100 });
    expect(nearB[0].data?.middle).toEqual({ x: 286, y: 100 });
    expect(ids(collectionGridCollisionDetection(args('game', { x: 390, y: 100 })))).toEqual(['c']);
  });

  it('the plain detection finds nothing in that gutter (why the drop used to be ignored)', () => {
    expect(collectionCollisionDetection(args('game', { x: 380, y: 100 }))).toEqual([]);
  });

  it('outside the grid: nothing', () => {
    expect(collectionGridCollisionDetection(args('game', { x: 700, y: 100 }))).toEqual([]);
    expect(collectionGridCollisionDetection(args('game', { x: 300, y: 260 }))).toEqual([]);
    expect(collectionGridCollisionDetection(args('game', { x: -50, y: 100 }))).toEqual([]);
  });

  it('a rail row still resolves to the rail row', () => {
    expect(ids(collectionGridCollisionDetection(args('game', { x: -200, y: 15 })))).toEqual(['rail']);
  });

  it('a collection drag gets no fallback onto a card', () => {
    expect(collectionGridCollisionDetection(args('collection', { x: 380, y: 100 }))).toEqual([]);
  });

  // Two rows, like 7 cards at 1280 (5 across): a..e, then f, g and three empty cells.
  const grid: Record<string, ClientRect> = {
    ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id, i) => [id, rect(196 * i, 0)])),
    f: rect(0, 216), g: rect(196, 216),
    rail: rect(-300, 0, 200, 30),
  };

  it('an empty cell after the last card goes to the LAST card (append), not the card above it', () => {
    // The middle of the empty cell after g: nearest by distance is d, straight above it.
    const cell = { x: 392 + 90, y: 216 + 100 };
    const got = collectionGridCollisionDetection(args('game', cell, grid));
    expect(ids(got)).toEqual(['g']);
    expect(got[0].data?.zone).toBe('edge');
    // The far right of the last row's band too.
    expect(ids(collectionGridCollisionDetection(args('game', { x: 196 * 4 + 170, y: 216 + 20 }, grid)))).toEqual(['g']);
  });

  it('the gutter between the rows, above the empty cells, is still nearest (the card above)', () => {
    expect(ids(collectionGridCollisionDetection(args('game', { x: 392 + 90, y: 208 }, grid)))).toEqual(['c']);
  });

  it('below the last row is outside the grid', () => {
    expect(collectionGridCollisionDetection(args('game', { x: 392 + 90, y: 216 + 230 }, grid))).toEqual([]);
  });
});
