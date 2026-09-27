import { describe, it, expect } from 'vitest';
import { adfDensity, isHdAdf, isHfeFilename, isServable } from './disk-format';

describe('disk-format', () => {
  it('recognises .hfe case-insensitively and nothing else', () => {
    expect(isHfeFilename('Game (1990)(X)[cr].HFE')).toBe(true);
    expect(isHfeFilename('game.hfe')).toBe(true);
    expect(isHfeFilename('game.hfe.adf')).toBe(false);
    expect(isHfeFilename('hfe')).toBe(false);
  });

  it('adfDensity knows exactly two sizes', () => {
    expect(adfDensity(901_120)).toBe('dd');
    expect(adfDensity(1_802_240)).toBe('hd');
    expect(adfDensity(1_802_239)).toBeNull();
    expect(adfDensity(2_049_024)).toBeNull();
    expect(adfDensity(0)).toBeNull();
  });

  it('HD is a property of an ADF row, never of an HFE of the same size', () => {
    expect(isHdAdf({ imageFormat: 'adf', sizeBytes: 1_802_240 })).toBe(true);
    expect(isHdAdf({ imageFormat: 'hfe', sizeBytes: 1_802_240 })).toBe(false);
    expect(isHdAdf({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(false);
  });

  it('an ADF is servable at exactly 901,120 or 1,802,240 bytes; an HFE always (validated at ingest); anything else never', () => {
    expect(isServable({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(true);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 1_802_240 })).toBe(true);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 2_049_024 })).toBe(false);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 900_000 })).toBe(false);
    expect(isServable({ imageFormat: 'hfe', sizeBytes: 2_049_024 })).toBe(true);
    expect(isServable({ imageFormat: 'ipf', sizeBytes: 901_120 })).toBe(false);
  });
});
