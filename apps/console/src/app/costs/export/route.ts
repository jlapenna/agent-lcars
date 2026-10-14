import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { archiveWindowLabel } from '@/lib/archive-window';
import { ledgerCsv } from '@/lib/ledger-csv';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '@/lib/session-archive';

import { parseViewFilters } from '../../sessions/session-view-filters';

/** "Export ledger": the cost ledger for the same window and filters as
 * /costs, as a CSV download. Admin-only like the page. */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = Object.fromEntries(new URL(request.url).searchParams);
  // The same FIND as the page, so the export is the ledger the page shows.
  const { q } = parseViewFilters(params);
  const query = { ...parseSessionArchiveQuery(params), ...(q && { q }) };
  const { ledger, warnings } = await getSessionArchive(query);
  return new NextResponse(ledgerCsv(ledger), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lcars-cost-ledger-${archiveWindowLabel(query.days)}.csv"`,
      'Cache-Control': 'no-store',
      ...(warnings.length > 0 && {
        'X-Ledger-Warnings': String(warnings.length),
      }),
    },
  });
}
