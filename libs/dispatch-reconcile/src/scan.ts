import { DISPATCH_LABELS } from '@agent-lcars/dispatch-contracts';

export const CLOSED_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_DISPATCH_CONCURRENCY = 5;
export const RECONCILE_OIDC_AUDIENCE = 'agent-lcars-dispatch-reconcile';
export const RECONCILE_WORKFLOW_PATH =
  '.github/workflows/dispatch-reconcile.yml';

export interface ReconcileIssue {
  number: number;
}

export interface ReconcileIssueQuery {
  repository: string;
  state: 'open' | 'closed';
  label?: string;
  assignee?: string;
  since?: string;
  page: number;
  perPage: number;
}

export interface ReconcileTransport {
  listIssues: (query: ReconcileIssueQuery) => Promise<ReconcileIssue[]>;
  dispatchReconcile: (repository: string, issue: number) => Promise<unknown>;
}

export interface ReconcileScanResult {
  candidates: number;
  dispatched: number;
  failed: { issue: number; message: string }[];
  openCandidates: number;
  closedCandidates: number;
}

async function listAllIssues(
  transport: ReconcileTransport,
  query: Omit<ReconcileIssueQuery, 'page' | 'perPage'>,
): Promise<ReconcileIssue[]> {
  const all: ReconcileIssue[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const items = await transport.listIssues({
      ...query,
      page,
      perPage: 100,
    });
    if (!Array.isArray(items)) {
      throw new Error('GitHub issue listing response is not an array');
    }
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error('GitHub issue pagination exceeded safety bound');
}

function dedupeIssues(lanes: ReconcileIssue[][]): ReconcileIssue[] {
  const byNumber = new Map<number, ReconcileIssue>();
  for (const issue of lanes.flat()) {
    if (Number.isSafeInteger(issue?.number)) byNumber.set(issue.number, issue);
  }
  return [...byNumber.values()].sort(
    (left, right) => left.number - right.number,
  );
}

async function listLabeledIssues(
  transport: ReconcileTransport,
  repository: string,
  state: 'open' | 'closed',
  since?: string,
): Promise<ReconcileIssue[]> {
  const lanes = await Promise.all(
    DISPATCH_LABELS.map((label) =>
      listAllIssues(transport, {
        repository,
        state,
        label,
        ...(since && { since }),
      }),
    ),
  );
  return dedupeIssues(lanes);
}

async function listAssignedIssues(
  transport: ReconcileTransport,
  repository: string,
  state: 'open' | 'closed',
  assignee: string,
  since?: string,
): Promise<ReconcileIssue[]> {
  if (!assignee) return [];
  return listAllIssues(transport, {
    repository,
    state,
    assignee,
    ...(since && { since }),
  });
}

export function listOpenAgentLabeledIssues(
  transport: ReconcileTransport,
  repository: string,
): Promise<ReconcileIssue[]> {
  return listLabeledIssues(transport, repository, 'open');
}

export function listOpenIssuesAssignedTo(
  transport: ReconcileTransport,
  repository: string,
  fleetLogin: string,
): Promise<ReconcileIssue[]> {
  return listAssignedIssues(transport, repository, 'open', fleetLogin);
}

export function listRecentlyClosedAgentLabeledIssues(
  transport: ReconcileTransport,
  repository: string,
  now: Date | string = new Date(),
): Promise<ReconcileIssue[]> {
  const since = new Date(
    new Date(now).getTime() - CLOSED_SWEEP_WINDOW_MS,
  ).toISOString();
  return listLabeledIssues(transport, repository, 'closed', since);
}

export function listRecentlyClosedIssuesAssignedTo(
  transport: ReconcileTransport,
  repository: string,
  fleetLogin: string,
  now: Date | string = new Date(),
): Promise<ReconcileIssue[]> {
  const since = new Date(
    new Date(now).getTime() - CLOSED_SWEEP_WINDOW_MS,
  ).toISOString();
  return listAssignedIssues(transport, repository, 'closed', fleetLogin, since);
}

export async function discoverReconcileCandidates(
  transport: ReconcileTransport,
  repository: string,
  fleetLogin: string,
): Promise<ReconcileIssue[]> {
  return dedupeIssues(
    await Promise.all([
      listOpenAgentLabeledIssues(transport, repository),
      listOpenIssuesAssignedTo(transport, repository, fleetLogin),
    ]),
  );
}

export async function discoverRecentlyClosedReconcileCandidates(
  transport: ReconcileTransport,
  repository: string,
  fleetLogin: string,
  now: Date | string = new Date(),
): Promise<ReconcileIssue[]> {
  return dedupeIssues(
    await Promise.all([
      listRecentlyClosedAgentLabeledIssues(transport, repository, now),
      listRecentlyClosedIssuesAssignedTo(
        transport,
        repository,
        fleetLogin,
        now,
      ),
    ]),
  );
}

type ConcurrencyOutcome =
  { status: 'fulfilled' } | { status: 'rejected'; reason: unknown };

async function mapWithConcurrency(
  items: number[],
  worker: (item: number) => Promise<unknown>,
): Promise<ConcurrencyOutcome[]> {
  const results: ConcurrencyOutcome[] = new Array(items.length);
  let cursor = 0;
  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index]);
        results[index] = { status: 'fulfilled' };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(RECONCILE_DISPATCH_CONCURRENCY, items.length) },
      () => runNext(),
    ),
  );
  return results;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function dispatchReconcileScan(
  transport: ReconcileTransport,
  repository: string,
  issueNumbers: number[],
): Promise<Pick<ReconcileScanResult, 'dispatched' | 'failed'>> {
  const outcomes = await mapWithConcurrency(issueNumbers, (issue) =>
    transport.dispatchReconcile(repository, issue),
  );
  const result: Pick<ReconcileScanResult, 'dispatched' | 'failed'> = {
    dispatched: 0,
    failed: [],
  };
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      result.dispatched += 1;
    } else {
      result.failed.push({
        issue: issueNumbers[index],
        message: errorMessage(outcome.reason),
      });
    }
  });
  return result;
}

export async function runReconcileScan(
  transport: ReconcileTransport,
  repository: string,
  fleetLogin: string,
  now: Date | string = new Date(),
): Promise<ReconcileScanResult> {
  const [open, closed] = await Promise.all([
    discoverReconcileCandidates(transport, repository, fleetLogin),
    discoverRecentlyClosedReconcileCandidates(
      transport,
      repository,
      fleetLogin,
      now,
    ),
  ]);
  const issueNumbers = dedupeIssues([open, closed]).map(
    (issue) => issue.number,
  );
  const dispatched = await dispatchReconcileScan(
    transport,
    repository,
    issueNumbers,
  );
  return {
    candidates: issueNumbers.length,
    ...dispatched,
    openCandidates: open.length,
    closedCandidates: closed.length,
  };
}
