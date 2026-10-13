import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { ledgerCsv } from '@/lib/ledger-csv';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '@/lib/session-archive';

/** "Export ledger": the cost ledger for the same window and filters as
 * /costs, as a CSV download. Admin-only like the page. */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = parseSessionArchiveQuery(params);
  const { ledger, warnings } = await getSessionArchive(query);
  return new NextResponse(ledgerCsv(ledger), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lcars-cost-ledger-${query.days}d.csv"`,
      'Cache-Control': 'no-store',
      ...(warnings.length > 0 && {
        'X-Ledger-Warnings': String(warnings.length),
      }),
    },
  });
}
