/**
 * Plain-text wording for the error codes POST /api/games/[id]/disks answers
 * with, shared by the "Add disks…" dialog and the upload-page suggestion so a
 * person never sees a raw code like "same_title".
 */
export function addErrorText(code: unknown): string | undefined {
  switch (code) {
    case 'same_title': return 'Those disks are already in this set.';
    case 'nothing_to_add': return 'There were no disks to add.';
    case 'not_found': return 'A title or disk is no longer in your library.';
    case 'stale_order': return 'The set changed meanwhile; try again.';
    case 'invalid_body': return 'The request was not accepted — check the name and the disks picked.';
    case 'invalid_json': return 'The request was malformed; try again.';
    default: return typeof code === 'string' ? code : undefined;
  }
}

/**
 * Codes meaning the disks the suggestion was built from have moved on (another
 * tab made or changed a set, or a disk was deleted): the panel is stale, so the
 * page reloads its data and the panel goes, rather than offering a retry.
 */
export function isStaleSuggestion(code: unknown): boolean {
  return code === 'same_title' || code === 'not_found';
}
