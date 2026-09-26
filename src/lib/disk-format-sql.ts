// isHdAdf (disk-format.ts) for statements that must decide HD inside the
// query itself: an UPDATE's WHERE (a refusal that cannot race a concurrent
// write) or a GROUP BY aggregate. Kept out of disk-format.ts so client
// components that import that module never pull in drizzle.
import { sql, type SQL } from 'drizzle-orm';
import { disks } from '@/db/schema/catalog';
import { ADF_HD_BYTES } from '@/lib/adfmfm/constants';

export function isHdAdfSql(): SQL {
  return sql`(${disks.imageFormat} = 'adf' and ${disks.sizeBytes} = ${ADF_HD_BYTES})`;
}
