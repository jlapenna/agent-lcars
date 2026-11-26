import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    project: { type: 'string' },
    database: { type: 'string' },
    'start-after': { type: 'string' },
    'active-since': { type: 'string' },
    'page-size': { type: 'string' },
  },
});
if (!values.project || !values.database) {
  throw new Error(
    'Usage: pnpm exec tsx tools/backfill-session-spend.mts --project <project-id> --database <database-id> [--apply] [--start-after <cursor>] [--active-since <iso>] [--page-size <n>]',
  );
}
const pageSize =
  values['page-size'] === undefined ? undefined : Number(values['page-size']);
if (pageSize !== undefined && !Number.isInteger(pageSize)) {
  throw new Error(`--page-size must be an integer, got ${values['page-size']}`);
}
if (
  values['active-since'] !== undefined &&
  Number.isNaN(Date.parse(values['active-since']))
) {
  throw new Error(
    `--active-since must be a parseable timestamp, got ${values['active-since']}`,
  );
}

// Both are read at module scope by the telemetry server, so they have to be set
// before the import below resolves.
process.env['PROJECT_ID'] = values.project;
process.env['AGENT_TELEMETRY_DATABASE_ID'] = values.database;
const { backfillSessionSpend } = await import('@agent-lcars/telemetry/server');

let cursor = values['start-after'];
let scanned = 0;
let stale = 0;
let written = 0;
let unusable = 0;
let outsideWindow = 0;
for (;;) {
  const page = await backfillSessionSpend({
    apply: values.apply,
    cursor,
    activeSince: values['active-since'],
    pageSize,
  });
  scanned += page.scanned;
  stale += page.stale;
  written += page.written;
  unusable += page.unusable;
  outsideWindow += page.scannedOutsideWindow;
  cursor = page.nextCursor;
  console.log(
    JSON.stringify({
      mode: values.apply ? 'apply' : 'dry-run',
      scanned,
      stale,
      written,
      unusable,
      outsideWindow,
      nextCursor: cursor ?? null,
    }),
  );
  if (cursor === undefined) break;
}
if (!values.apply) {
  // The operator's acceptance is a dry run reporting BOTH `stale: 0` and
  // `unusable: 0`, taken after every runner image carries the writer change: a
  // session an older writer is still updating is stale again the moment it is
  // written, and an unusable one is a session no writer ever priced, which an
  // indexed total counts as free rather than wrong. --apply on its own is
  // progress, not coverage.
  console.log(
    `Dry run over ${scanned} docs: ${stale} stale, ${unusable} without readable usage, ` +
      `${outsideWindow} outside the active window. ${
        stale === 0 && unusable === 0
          ? 'Indexed totals are covered for this window.'
          : 'Totals cutover is not covered: stale and unusable must both be 0 (or reconciled against the ledger).'
      }`,
  );
}
