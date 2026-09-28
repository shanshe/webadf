'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { NextInfo } from '@/lib/next-disk';
import { requestNextDisk } from './device-actions';

export function NextDiskButton({ deviceId, next }: { deviceId: string; next: NextInfo }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      if (await requestNextDisk(deviceId)) start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={busy || pending}
            data-testid={`next-disk-${deviceId}`}
            className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
      {busy || pending ? 'Switching…' : `Next: disk ${next.diskNo}`}
    </button>
  );
}
