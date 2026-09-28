import { describe, it, expect } from 'vitest';
import { releaseTag, suggestSet, type SuggestInput } from './disk-set-suggest';

const f = (filename: string, volumeName: string | null = null, relativePath?: string): SuggestInput =>
  ({ diskId: `d-${filename}`, gameId: `g-${filename}`, filename, volumeName, relativePath });

describe('releaseTag', () => {
  it.each([['Install3_1_4.adf', '3.1.4'], ['ModulesA1200_3.1.4.adf', '3.1.4'], ['Workbench3.1.4', '3.1.4'], ['Fonts.adf', null], ['Turrican2.adf', null]])(
    '%s -> %s', (s, t) => expect(releaseTag(s)).toBe(t));
});

describe('suggestSet', () => {
  it('builds the AmigaOS 3.1.4 set from the real release names', () => {
    const s = suggestSet([
      f('Extras3_1_4.adf'), f('Fonts.adf'), f('Install3_1_4.adf'), f('Locale.adf'),
      f('ModulesA1200_3.1.4.adf'), f('Storage3_1_4.adf'), f('Workbench3_1_4.adf'),
    ])!;
    expect(s.name).toBe('AmigaOS 3.1.4');
    expect(s.disks.map((d) => [d.label, d.ticked])).toEqual([
      ['Install3_1_4', true], ['Workbench3_1_4', true], ['Extras3_1_4', true],
      ['ModulesA1200_3.1.4', true], ['Storage3_1_4', true], ['Fonts', false], ['Locale', false],
    ]);
  });
  it('prefers volume names for labels and tags', () => {
    const s = suggestSet([f('a.adf', 'Install3.1.4'), f('b.adf', 'Extras3.1.4')])!;
    expect(s.disks.map((d) => d.label)).toEqual(['Install3.1.4', 'Extras3.1.4']);
  });
  it('names a set with no OS hint "<tag> set"', () => {
    expect(suggestSet([f('GameA_1.2.adf'), f('GameB_1.2.adf')])!.name).toBe('1.2 set');
  });
  it('gives nothing when no two disks share a tag or folder', () => {
    expect(suggestSet([f('Turrican.adf'), f('Lemmings.adf')])).toBeNull();
    expect(suggestSet([f('Install3_1_4.adf')])).toBeNull();
  });
  it('uses a shared dropped folder as the name and ticks everything', () => {
    const s = suggestSet([f('Fonts.adf', null, 'My Set/Fonts.adf'), f('Locale.adf', null, 'My Set/Locale.adf')])!;
    expect(s.name).toBe('My Set');
    expect(s.disks.every((d) => d.ticked)).toBe(true);
  });
  it('refuses more than 32 disks', () => {
    expect(suggestSet(Array.from({ length: 33 }, (_, i) => f(`X${i}_1.0.adf`)))).toBeNull();
  });
});
