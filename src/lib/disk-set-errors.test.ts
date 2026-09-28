import { describe, expect, it } from 'vitest';
import { addErrorText, isStaleSuggestion } from './disk-set-errors';

describe('addErrorText', () => {
  it.each(['same_title', 'nothing_to_add', 'not_found', 'stale_order', 'invalid_body', 'invalid_json'])(
    'turns %s into a sentence, never the raw code', (code) => {
      const text = addErrorText(code)!;
      expect(text).not.toContain(code);
      expect(text).toMatch(/^[A-Z].*\.$/);
    });
  it('passes an unknown string through and ignores a non-string', () => {
    expect(addErrorText('teapot')).toBe('teapot');
    expect(addErrorText(undefined)).toBeUndefined();
    expect(addErrorText({})).toBeUndefined();
  });
});

describe('isStaleSuggestion', () => {
  it('is true only for same_title and not_found', () => {
    expect(isStaleSuggestion('same_title')).toBe(true);
    expect(isStaleSuggestion('not_found')).toBe(true);
    for (const c of ['stale_order', 'nothing_to_add', 'invalid_body', undefined]) expect(isStaleSuggestion(c)).toBe(false);
  });
});
