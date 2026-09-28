/**
 * Disk sets (spec 2026-09-28-disk-sets §3): the upload-page suggestion --
 * pure, so it is tested without a database or file I/O.
 */
export type SuggestInput = { diskId: string; gameId: string; filename: string; volumeName: string | null; relativePath?: string };
export type Suggestion = { name: string; disks: Array<{ diskId: string; gameId: string; label: string; ticked: boolean }> } | null;

function stripExt(s: string): string {
  return s.replace(/\.[A-Za-z]+$/, '');
}

/**
 * The first digit run in `s` (extension stripped), e.g. "3_1_4" or "3.1.4".
 * A run may mix separators (a model number glued to a dotted version, e.g.
 * "A1200_3.1.4"); the tag is the maximal *consistent*-separator suffix of
 * that run, normalised to dots, capped at 4 components (the `{1,3}` reps).
 */
export function releaseTag(s: string): string | null {
  const run = stripExt(s).match(/\d+(?:[._]\d+)*/)?.[0];
  if (!run) return null;

  const numbers: string[] = [];
  const seps: string[] = [];
  const tokens = run.match(/\d+|[._]/g) ?? [];
  for (const tok of tokens) (/\d/.test(tok) ? numbers : seps).push(tok);
  if (numbers.length < 2) return null;

  let start = numbers.length - 1;
  const sepChar = seps[seps.length - 1];
  for (let i = seps.length - 1; i >= 0 && seps[i] === sepChar; i--) start = i;

  let tag = numbers.slice(start);
  if (tag.length < 2) return null;
  if (tag.length > 4) tag = tag.slice(tag.length - 4);
  return tag.join('.');
}

function labelOf(d: SuggestInput): string {
  return d.volumeName ?? stripExt(d.filename);
}

function tagOf(d: SuggestInput): string | null {
  return releaseTag(d.volumeName ?? d.filename);
}

function folderOf(d: SuggestInput): string | null {
  const path = d.relativePath;
  if (!path) return null;
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : null;
}

const rank = (label: string): number => (/^install/i.test(label) ? 0 : /^workbench/i.test(label) ? 1 : 2);

export function suggestSet(files: SuggestInput[]): Suggestion {
  if (files.length < 2 || files.length > 32) return null;

  const tags = files.map(tagOf);
  const counts = new Map<string, number>();
  for (const t of tags) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  let winningTag: string | null = null;
  let bestCount = 0;
  for (const [t, c] of counts) if (c > bestCount) { bestCount = c; winningTag = t; }
  if (bestCount < 2) winningTag = null;

  const folders = files.map(folderOf);
  const sharedFolder = folders[0] !== null && folders.every((f) => f === folders[0]) ? folders[0] : null;

  let ticked: boolean[];
  if (winningTag) ticked = tags.map((t) => t === winningTag);
  else if (sharedFolder) ticked = files.map(() => true);
  else return null;

  let name: string;
  if (sharedFolder) {
    name = sharedFolder;
  } else {
    const isAmigaOSHint = (d: SuggestInput) =>
      /amigaos/i.test(d.filename) || (d.volumeName !== null && /amigaos/i.test(d.volumeName)) ||
      /^(workbench|install)/i.test(d.filename) || (d.volumeName !== null && /^(workbench|install)/i.test(d.volumeName));
    name = files.some(isAmigaOSHint) ? `AmigaOS ${winningTag}` : `${winningTag} set`;
  }

  const disks = files
    .map((d, i) => ({ diskId: d.diskId, gameId: d.gameId, label: labelOf(d), ticked: ticked[i], rank: rank(labelOf(d)), i }))
    .sort((a, b) => (a.ticked !== b.ticked ? (a.ticked ? -1 : 1) : a.rank !== b.rank ? a.rank - b.rank : a.i - b.i))
    .map(({ diskId, gameId, label, ticked: t }) => ({ diskId, gameId, label, ticked: t }));

  return { name, disks };
}
