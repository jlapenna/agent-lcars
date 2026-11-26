import { createHash } from 'node:crypto';

import {
  type TrackerIssue,
  trackerIssueDisplay,
  trackerIssueSchema,
} from '@agent-lcars/dispatch-contracts';

import type { Run } from './model';

export interface IssueSnapshotReader {
  readIssueSnapshot(id: string): Promise<TrackerIssue | undefined>;
  /** A bounded set of unique snapshot IDs for a single detail view. */
  readIssueSnapshots(
    ids: readonly string[],
  ): Promise<Map<string, TrackerIssue>>;
}

export function prepareIssueSnapshot(input: unknown) {
  const issue = trackerIssueSchema.parse(input);
  // Sort object keys recursively and preserve array order. Hashes stay
  // stable across input order and schema declaration order.
  const canonical = JSON.stringify(issue, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
  const id = createHash('sha256').update(canonical).digest('hex');
  return { reference: { id, ...trackerIssueDisplay(issue) }, issue };
}

export async function readRunIssue(
  store: Pick<IssueSnapshotReader, 'readIssueSnapshot'>,
  run: Run,
): Promise<TrackerIssue | undefined> {
  if (run.issueSnapshot === undefined) return run.issue;
  const issue = await store.readIssueSnapshot(run.issueSnapshot.id);
  if (issue === undefined) {
    throw new Error(`Missing issue snapshot for run ${run.runId}`);
  }
  return issue;
}

export async function readRunIssues(
  store: Pick<IssueSnapshotReader, 'readIssueSnapshots'>,
  runs: readonly Run[],
): Promise<Map<string, TrackerIssue>> {
  const ids = new Set(
    runs.flatMap((run) => (run.issueSnapshot ? [run.issueSnapshot.id] : [])),
  );
  const snapshots = await store.readIssueSnapshots([...ids]);
  const issues = new Map<string, TrackerIssue>();
  for (const run of runs) {
    const issue = run.issueSnapshot
      ? snapshots.get(run.issueSnapshot.id)
      : run.issue;
    if (issue) issues.set(run.runId, issue);
    else if (run.issueSnapshot) {
      throw new Error(`Missing issue snapshot for run ${run.runId}`);
    }
  }
  return issues;
}
