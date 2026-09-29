import { describe, expect, it } from 'vitest';
import { appliedMessage, queryTooShort, resultsAnnouncement, tosecApplyBody } from './identify-search-logic';

describe('queryTooShort', () => {
  it.each(['', ' ', 'a', '  a  ', '\ta\n'])('is true for %j', (q) => expect(queryTooShort(q)).toBe(true));
  it.each(['ab', ' ab ', 'a b'])('is false for %j', (q) => expect(queryTooShort(q)).toBe(false));
});

describe('tosecApplyBody', () => {
  it('sends every identity field, known or not', () => {
    expect(tosecApplyBody({ title: 'Lemmings', year: 1991, publisher: 'Psygnosis' }))
      .toEqual({ title: 'Lemmings', year: 1991, publisher: 'Psygnosis' });
  });

  it('sends null (clear), not nothing (keep), for an unknown year or publisher', () => {
    const body = tosecApplyBody({ title: 'X', year: null, publisher: null });
    expect(body).toEqual({ title: 'X', year: null, publisher: null });
    // Survives JSON: the keys are present with null, not dropped.
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty('year', null);
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty('publisher', null);
  });
});

describe('appliedMessage', () => {
  it('says the details were set when something changed', () => {
    expect(appliedMessage({ id: 'g', changed: ['identity'] })).toEqual({ kind: 'success', text: 'Details set from TOSEC' });
  });

  it('does not claim a change when the PATCH changed nothing', () => {
    expect(appliedMessage({ id: 'g', changed: [] }).kind).toBe('info');
    expect(appliedMessage({ id: 'g', changed: [] }).text).not.toMatch(/set from/i);
  });

  it('falls back to success for an unexpected body (the request did succeed)', () => {
    expect(appliedMessage(null).kind).toBe('success');
    expect(appliedMessage({}).kind).toBe('success');
  });
});

describe('resultsAnnouncement', () => {
  it('counts results across both catalogs', () => {
    expect(resultsAnnouncement(1, 0, 'all')).toBe('1 result');
    expect(resultsAnnouncement(2, 3, 'all')).toBe('5 results');
  });

  it('names the catalogs searched when nothing matched', () => {
    expect(resultsAnnouncement(0, 0, 'all')).toBe('Nothing on Demozoo or TOSEC with that title.');
    expect(resultsAnnouncement(0, 0, 'tosec')).toBe('No TOSEC release with that title.');
  });
});
