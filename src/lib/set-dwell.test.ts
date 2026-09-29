import { describe, it, expect } from 'vitest';
import { ARM_DELAY_MS, IDLE_DWELL, armedId, dwellOver, dwellTick, dropIntent } from './set-dwell';

describe('set dwell (hover-to-add inside a collection)', () => {
  it('waits 500 ms', () => {
    expect(ARM_DELAY_MS).toBe(500);
  });

  it('is not armed the moment a card is over another', () => {
    const s = dwellOver(IDLE_DWELL, 'b', 1000);
    expect(armedId(s)).toBeNull();
    expect(armedId(dwellTick(s, 1000 + ARM_DELAY_MS - 1))).toBeNull();
  });

  it('arms after ARM_DELAY_MS on the same target', () => {
    const s = dwellTick(dwellOver(IDLE_DWELL, 'b', 1000), 1000 + ARM_DELAY_MS);
    expect(armedId(s)).toBe('b');
  });

  it('staying over the same target does not restart the clock', () => {
    let s = dwellOver(IDLE_DWELL, 'b', 1000);
    s = dwellOver(s, 'b', 1300);
    expect(armedId(dwellTick(s, 1000 + ARM_DELAY_MS))).toBe('b');
  });

  it('an over event on the same target after the delay arms too', () => {
    const s = dwellOver(dwellOver(IDLE_DWELL, 'b', 1000), 'b', 1000 + ARM_DELAY_MS);
    expect(armedId(s)).toBe('b');
  });

  it('a change of target restarts the clock', () => {
    let s = dwellOver(IDLE_DWELL, 'b', 1000);
    s = dwellOver(s, 'c', 1400);
    expect(armedId(dwellTick(s, 1000 + ARM_DELAY_MS))).toBeNull();
    expect(armedId(dwellTick(s, 1400 + ARM_DELAY_MS))).toBe('c');
  });

  it('moving off an armed target disarms it', () => {
    const armed = dwellTick(dwellOver(IDLE_DWELL, 'b', 0), ARM_DELAY_MS);
    expect(armedId(dwellOver(armed, null, ARM_DELAY_MS + 10))).toBeNull();
    const moved = dwellOver(armed, 'c', ARM_DELAY_MS + 10);
    expect(armedId(moved)).toBeNull();
    // ...and the new target starts its own full wait.
    expect(armedId(dwellTick(moved, ARM_DELAY_MS + 10 + ARM_DELAY_MS - 1))).toBeNull();
  });

  it('coming back to a card after leaving it starts over', () => {
    let s = dwellOver(IDLE_DWELL, 'b', 0);
    s = dwellOver(s, null, 300);
    s = dwellOver(s, 'b', 400);
    expect(armedId(dwellTick(s, ARM_DELAY_MS))).toBeNull();
    expect(armedId(dwellTick(s, 400 + ARM_DELAY_MS))).toBe('b');
  });

  it('a tick with nothing under the pointer changes nothing', () => {
    expect(dwellTick(IDLE_DWELL, 99_999)).toEqual(IDLE_DWELL);
  });

  it('a drop on the armed target means "make a set"', () => {
    const s = dwellTick(dwellOver(IDLE_DWELL, 'b', 0), ARM_DELAY_MS);
    expect(dropIntent(s, 'b')).toBe('set');
  });

  it('a drop on an unarmed target means "reorder"', () => {
    expect(dropIntent(dwellOver(IDLE_DWELL, 'b', 0), 'b')).toBe('reorder');
    expect(dropIntent(IDLE_DWELL, 'b')).toBe('reorder');
  });

  it('a drop somewhere other than the armed target is not a set', () => {
    const s = dwellTick(dwellOver(IDLE_DWELL, 'b', 0), ARM_DELAY_MS);
    expect(dropIntent(s, 'c')).toBe('reorder');
    expect(dropIntent(s, null)).toBe('reorder');
  });
});
