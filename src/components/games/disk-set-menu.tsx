'use client';

// A disk row's ⋯ menu when the row is one of a disk set (mockup view 1).
// Its own module, not part of disk-set-section.tsx, so disk-row.tsx can import
// it without a cycle (the section renders DiskRow).

import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface DiskSetControls {
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onMoveOut: () => void;
}

// The drive-chip menu's item look (drive-chips.tsx ITEM_CLASS), with a 44px
// row below `sm` so a finger can hit it.
const ITEM_CLASS =
  'min-h-11 px-2 py-1 text-[13px] sm:min-h-8 focus:bg-black/5 data-highlighted:bg-black/5';

export function DiskSetMenu({ diskId, name, controls }: {
  diskId: string;
  name: string;
  controls: DiskSetControls;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`disk-menu-${diskId}`}
        aria-label={`Disk set actions for ${name}`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg sm:h-8 sm:w-8"
        style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
      >
        <MoreHorizontal size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48 max-w-[calc(100vw-2rem)] backdrop-blur-xl"
        style={{ background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' }}
      >
        <DropdownMenuItem data-testid={`disk-up-${diskId}`} className={ITEM_CLASS}
                          disabled={!controls.canUp} onClick={controls.onUp}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem data-testid={`disk-down-${diskId}`} className={ITEM_CLASS}
                          disabled={!controls.canDown} onClick={controls.onDown}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1" style={{ background: 'var(--hairline-strong)' }} />
        <DropdownMenuItem data-testid={`disk-move-out-${diskId}`} className={ITEM_CLASS}
                          onClick={controls.onMoveOut}>
          Move out of set
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
