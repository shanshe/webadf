'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestWriteProtect } from '@/components/devices/device-actions';

export function WriteProtectToggle({ diskId, writeProtected, locked }: {
  diskId: string; writeProtected: boolean;
  /**
   * Why this disk can never be made writable (HD spec §4.3), shown as the
   * tooltip. Present means the toggle is disabled and reads Protected --
   * stated, not hidden, so "read-only" is a visible value.
   */
  locked?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const shownProtected = writeProtected || locked !== undefined;

  async function onToggle() {
    setBusy(true);
    try {
      if (await requestWriteProtect(diskId, !writeProtected)) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onToggle} disabled={busy || locked !== undefined}
            data-testid={`wp-${diskId}`} data-protected={shownProtected ? 'true' : 'false'}
            data-locked={locked !== undefined ? 'true' : undefined}
            aria-pressed={shownProtected}
            title={locked ?? (writeProtected
              ? 'Write protected — the device will refuse writes'
              : 'Writable — the device may write to this disk once write-back ships')}
            className="rounded-md border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide disabled:opacity-50"
            style={shownProtected
              // --hairline is 8% and read as no border at all, which made this
              // toggle look like a status chip rather than the control it is --
              // the clearest instance of the operator's "hard to distinguish
              // labels and buttons". --hairline-strong (14%) is still quiet
              // enough not to compete with the actions beside it.
              ? { borderColor: 'var(--hairline-strong)', color: 'var(--muted)' }
              : { borderColor: 'var(--amber-text)', color: 'var(--amber-text)' }}>
      {shownProtected ? 'Protected' : 'Writable'}
    </button>
  );
}
