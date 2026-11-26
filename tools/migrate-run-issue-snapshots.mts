import { parseArgs } from 'node:util';

import { FirestoreStore } from '@agent-lcars/orchestrator';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    project: { type: 'string' },
    database: { type: 'string' },
    'start-after': { type: 'string' },
  },
});
if (!values.project || !values.database) {
  throw new Error(
    'Usage: pnpm exec tsx tools/migrate-run-issue-snapshots.mts --project <project-id> --database <database-id> [--apply] [--start-after <cursor>]',
  );
}
const store = new FirestoreStore({
  projectId: values.project,
  databaseId: values.database,
});
let cursor = values['start-after'];
let scanned = 0;
let candidates = 0;
let migrated = 0;
for (;;) {
  const page = await store.migrateRunIssueSnapshots({
    apply: values.apply,
    cursor,
  });
  scanned += page.scanned;
  candidates += page.candidates;
  migrated += page.migrated;
  cursor = page.nextCursor;
  console.log(
    JSON.stringify({
      mode: values.apply ? 'apply' : 'dry-run',
      scanned,
      candidates,
      migrated,
      nextCursor: cursor ?? null,
    }),
  );
  if (cursor === undefined) break;
}
