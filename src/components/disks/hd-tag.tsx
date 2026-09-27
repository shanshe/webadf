/**
 * "HD" beside a disk's size (HD spec §4.2): on the game page's disk rows, the
 * library table and the upload list. One component, so the three read alike.
 * No hooks, so server and client components can both render it.
 */
export function HdTag({ testId }: { testId?: string }) {
  return (
    <span className="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide"
          style={{ border: '1px solid var(--hairline-strong)', color: 'var(--ink)' }}
          data-testid={testId}>HD</span>
  );
}
