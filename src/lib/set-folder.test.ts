import { describe, it, expect } from 'vitest';
import {
  ARM_DELAY_MS, CENTRE_HEIGHT_FRACTION, CENTRE_WIDTH_FRACTION, IDLE_FOLDER,
  armedId, dropOutcome, folderOver, folderTick, zoneOf,
} from './set-folder';

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

  it('an edge reorders, armed or not', () => {
    expect(dropOutcome(IDLE_FOLDER, { overId: 'b', zone: 'edge' })).toBe('reorder');
    expect(dropOutcome(armedOnB, { overId: 'b', zone: 'edge' })).toBe('reorder');
  });
});
