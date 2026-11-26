import { FirestoreStore } from '../libs/orchestrator/src/firestore-store';

// One-off repair for #3560. Requires Application Default Credentials with
// access to the explicitly named dispatch database.
const [apply, projectId, databaseId, ...extra] = process.argv.slice(2);
if (apply !== '--apply' || !projectId || !databaseId || extra.length > 0) {
  throw new Error(
    'Usage: pnpm exec tsx --tsconfig tsconfig.base.json tools/retire-terminal-queues.mts --apply <project-id> <database-id>',
  );
}

const store = new FirestoreStore({ projectId, databaseId });
let total = 0;
for (;;) {
  const retired = await store.retireTerminalQueueBatch();
  if (retired === 0) break;
  total += retired;
  console.log(
    `Retired ${total} terminal queues in ${projectId}/${databaseId}.`,
  );
}
console.log(
  `Retired ${total} terminal queues total. Final batch found zero matches.`,
);
