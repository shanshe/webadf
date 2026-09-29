import { describe, it, expect } from 'vitest';
import {
  ARM_DELAY_MS, CENTRE_HEIGHT_FRACTION, CENTRE_WIDTH_FRACTION, EDGE_INWARD_PX, EDGE_REST_MS, EDGE_REST_RADIUS_PX, IDLE_FOLDER,
  armedId, dropOutcome, folderMove, folderTick, nextDue, previewId, zoneOf, type FolderState,
} from './set-folder';

const P = { x: 0, y: 0 };
/** The pointer is in `id`'s centre (null: in no card at all). */
const folderOver = (s: FolderState, id: string | null, now: number) =>
  folderMove(s, id === null ? null : { id, zone: 'centre' }, P, now);
/** The pointer is at `p` in `id`'s edge (a card whose middle is `middle`, if given). */
const edge = (s: FolderState, id: string, p: { x: number; y: number }, now: number, middle?: { x: number; y: number }) =>
  folderMove(s, { id, zone: 'edge', middle }, p, now);

// A card-sized slot: 200 wide, 100 tall, so the centre is x 150..250, y 70..130.
const r = { left: 100, top: 50, width: 200, height: 100 };

describe('zoneOf', () => {
  it('is the middle 50% of the width and 60% of the height', () => {
    expect(CENTRE_WIDTH_FRACTION).toBe(0.5);
    expect(CENTRE_HEIGHT_FRACTION).toBe(0.6);
  });

  it('the middle of a card is centre', () => {
    expect(zoneOf({ x: 200, y: 100 }, r)).toBe('centre');
  });

  it('the centre boundary itself is centre, a pixel outside it is edge', () => {
    expect(zoneOf({ x: 150, y: 100 }, r)).toBe('centre');
    expect(zoneOf({ x: 250, y: 100 }, r)).toBe('centre');
    expect(zoneOf({ x: 200, y: 70 }, r)).toBe('centre');
    expect(zoneOf({ x: 200, y: 130 }, r)).toBe('centre');
    expect(zoneOf({ x: 149, y: 100 }, r)).toBe('edge');
    expect(zoneOf({ x: 251, y: 100 }, r)).toBe('edge');
    expect(zoneOf({ x: 200, y: 69 }, r)).toBe('edge');
    expect(zoneOf({ x: 200, y: 131 }, r)).toBe('edge');
  });

  it('the corners and the card\'s own border are edge', () => {
    expect(zoneOf({ x: 100, y: 50 }, r)).toBe('edge');
    expect(zoneOf({ x: 300, y: 150 }, r)).toBe('edge');
    expect(zoneOf({ x: 101, y: 100 }, r)).toBe('edge');
    expect(zoneOf({ x: 200, y: 149 }, r)).toBe('edge');
  });

  it('centre needs BOTH axes: a pointer in the middle column but the top band is edge', () => {
    expect(zoneOf({ x: 200, y: 55 }, r)).toBe('edge');
    expect(zoneOf({ x: 110, y: 100 }, r)).toBe('edge');
  });
});

describe('the arm state machine', () => {
  it('waits 300 ms', () => {
    expect(ARM_DELAY_MS).toBe(300);
  });

  it('is not armed the moment the pointer enters a centre', () => {
    const s = folderOver(IDLE_FOLDER, 'b', 1000);
    expect(armedId(s)).toBeNull();
    expect(armedId(folderTick(s, 1000 + ARM_DELAY_MS - 1))).toBeNull();
  });

  it('arms after ARM_DELAY_MS in the same centre', () => {
    expect(armedId(folderTick(folderOver(IDLE_FOLDER, 'b', 1000), 1000 + ARM_DELAY_MS))).toBe('b');
  });

  it('moving within the same centre keeps the clock, and the same object', () => {
    const s = folderOver(IDLE_FOLDER, 'b', 1000);
    const again = folderOver(s, 'b', 1200);
    expect(again).toBe(s);
    expect(armedId(folderTick(again, 1000 + ARM_DELAY_MS))).toBe('b');
  });

  it('a move event in the centre after the delay arms too', () => {
    expect(armedId(folderOver(folderOver(IDLE_FOLDER, 'b', 1000), 'b', 1000 + ARM_DELAY_MS))).toBe('b');
  });

  it('leaving the centre disarms at once', () => {
    const armed = folderTick(folderOver(IDLE_FOLDER, 'b', 0), ARM_DELAY_MS);
    expect(armedId(armed)).toBe('b');
    expect(armedId(folderOver(armed, null, ARM_DELAY_MS + 1))).toBeNull();
  });

  it('moving to another card\'s centre starts that card\'s own full wait', () => {
    const armed = folderTick(folderOver(IDLE_FOLDER, 'b', 0), ARM_DELAY_MS);
    const moved = folderOver(armed, 'c', 400);
    expect(armedId(moved)).toBeNull();
    expect(armedId(folderTick(moved, 400 + ARM_DELAY_MS - 1))).toBeNull();
    expect(armedId(folderTick(moved, 400 + ARM_DELAY_MS))).toBe('c');
  });

  it('coming back to a centre after leaving it starts over', () => {
    let s = folderOver(IDLE_FOLDER, 'b', 0);
    s = folderOver(s, null, 200);
    s = folderOver(s, 'b', 250);
    expect(armedId(folderTick(s, ARM_DELAY_MS))).toBeNull();
    expect(armedId(folderTick(s, 250 + ARM_DELAY_MS))).toBe('b');
  });

  it('no centre, no change: idle stays the same object and a tick does nothing', () => {
    expect(folderOver(IDLE_FOLDER, null, 5)).toBe(IDLE_FOLDER);
    expect(folderTick(IDLE_FOLDER, 99_999)).toBe(IDLE_FOLDER);
  });
});

describe('the edge preview waits for the pointer to rest', () => {
  it('waits 200 ms within 8 px', () => {
    expect(EDGE_REST_MS).toBe(200);
    expect(EDGE_REST_RADIUS_PX).toBe(8);
  });

  it('entering an edge shows no preview yet; resting there shows it', () => {
    const s = edge(IDLE_FOLDER, 'b', { x: 10, y: 10 }, 1000);
    expect(previewId(s)).toBeNull();
    expect(previewId(folderTick(s, 1000 + EDGE_REST_MS - 1))).toBeNull();
    expect(previewId(folderTick(s, 1000 + EDGE_REST_MS))).toBe('b');
  });

  it('drift inside the radius is still a rest', () => {
    let s = edge(IDLE_FOLDER, 'b', { x: 10, y: 10 }, 1000);
    s = edge(s, 'b', { x: 15, y: 15 }, 1100);   // ~7 px
    expect(previewId(folderTick(s, 1000 + EDGE_REST_MS))).toBe('b');
  });

  it('a pointer walking through the edge never rests, so nothing moves', () => {
    let s = edge(IDLE_FOLDER, 'b', { x: 0, y: 10 }, 1000);
    // 4 px every 16 ms, like a hand: past the radius every few steps.
    for (let i = 1; i <= 40; i++) s = edge(s, 'b', { x: 4 * i, y: 10 }, 1000 + 16 * i);
    expect(previewId(s)).toBeNull();
    // ...and then into the centre: still nothing previewing, and the centre starts its clock.
    s = folderOver(s, 'b', 1700);
    expect(previewId(s)).toBeNull();
    expect(s.targetId).toBe('b');
  });

  it('once showing, moving about in the same edge keeps it', () => {
    let s = folderTick(edge(IDLE_FOLDER, 'b', { x: 10, y: 10 }, 0), EDGE_REST_MS);
    s = edge(s, 'b', { x: 60, y: 10 }, EDGE_REST_MS + 16);
    expect(previewId(s)).toBe('b');
  });

  it('a very slow creep inward (1 px every 30 ms) through the edge never rests', () => {
    expect(EDGE_INWARD_PX).toBe(2);
    const middle = { x: 100, y: 50 };
    let s = edge(IDLE_FOLDER, 'b', { x: 0, y: 50 }, 0, middle);
    for (let i = 1; i <= 50; i++) {
      s = edge(s, 'b', { x: i, y: 50 }, 30 * i, middle);
      s = folderTick(s, 30 * i + 29);
      expect(previewId(s), `step ${i}`).toBeNull();
    }
  });

  it('the same slow speed ALONG the edge (not inward) is a rest', () => {
    const middle = { x: 100, y: 50 };
    let s = edge(IDLE_FOLDER, 'b', { x: 10, y: 50 }, 0, middle);
    for (let i = 1; i <= 7; i++) s = edge(s, 'b', { x: 10, y: 50 + i }, 30 * i, middle);
    expect(previewId(folderTick(s, EDGE_REST_MS))).toBe('b');
  });

  it('while its preview shows, a card\'s centre counts as edge: no arm, the preview stays, a drop reorders', () => {
    let s = folderTick(edge(IDLE_FOLDER, 'b', { x: 10, y: 10 }, 0), EDGE_REST_MS);
    s = folderOver(s, 'b', 300);
    expect(previewId(s)).toBe('b');
    expect(s.targetId).toBeNull();
    s = folderTick(s, 300 + ARM_DELAY_MS * 3);
    expect(armedId(s)).toBeNull();
    expect(dropOutcome(s, { overId: 'b', zone: 'centre' })).toBe('reorder');
  });

  it('leaving the slot and coming back into the centre starts a fresh arm', () => {
    let s = folderTick(edge(IDLE_FOLDER, 'b', { x: 10, y: 10 }, 0), EDGE_REST_MS);
    s = folderMove(s, null, P, 300);
    expect(previewId(s)).toBeNull();
    s = folderOver(s, 'b', 400);
    expect(armedId(folderTick(s, 400 + ARM_DELAY_MS))).toBe('b');
  });

  it('leaving the slot -- to a gap or another card -- drops the preview', () => {
    const showing = folderTick(edge(IDLE_FOLDER, 'b', { x: 10, y: 10 }, 0), EDGE_REST_MS);
    expect(previewId(folderMove(showing, null, P, 300))).toBeNull();
    const other = edge(showing, 'c', { x: 10, y: 10 }, 300);
    expect(previewId(other)).toBeNull();
    expect(previewId(folderTick(other, 300 + EDGE_REST_MS))).toBe('c');
  });

  it('nextDue names the arm or the rest deadline, and nothing when idle or done', () => {
    expect(nextDue(IDLE_FOLDER)).toBeNull();
    expect(nextDue(folderOver(IDLE_FOLDER, 'b', 1000))).toBe(1000 + ARM_DELAY_MS);
    expect(nextDue(folderTick(folderOver(IDLE_FOLDER, 'b', 1000), 1000 + ARM_DELAY_MS))).toBeNull();
    expect(nextDue(edge(IDLE_FOLDER, 'b', P, 1000))).toBe(1000 + EDGE_REST_MS);
    expect(nextDue(folderTick(edge(IDLE_FOLDER, 'b', P, 1000), 1000 + EDGE_REST_MS))).toBeNull();
  });
});

describe('dropOutcome', () => {
  const armedOnB = folderTick(folderOver(IDLE_FOLDER, 'b', 0), ARM_DELAY_MS);

  it('the armed card\'s centre makes a set', () => {
    expect(dropOutcome(armedOnB, { overId: 'b', zone: 'centre' })).toBe('set');
  });

  it('a centre before it arms does nothing', () => {
    expect(dropOutcome(folderOver(IDLE_FOLDER, 'b', 0), { overId: 'b', zone: 'centre' })).toBe('none');
    expect(dropOutcome(IDLE_FOLDER, { overId: 'b', zone: 'centre' })).toBe('none');
  });

  it('another card\'s centre is not the armed one: nothing', () => {
    expect(dropOutcome(armedOnB, { overId: 'c', zone: 'centre' })).toBe('none');
  });

  it('an edge reorders', () => {
    expect(dropOutcome(IDLE_FOLDER, { overId: 'b', zone: 'edge' })).toBe('reorder');
    expect(dropOutcome(armedOnB, { overId: 'c', zone: 'edge' })).toBe('reorder');
  });

  it('the armed state is trusted over a last frame that drifted into the edge', () => {
    expect(dropOutcome(armedOnB, { overId: 'b', zone: 'edge' })).toBe('set');
  });
});
