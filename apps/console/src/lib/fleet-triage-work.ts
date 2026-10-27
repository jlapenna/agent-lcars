import 'server-only';

import {
  FLEET_TRIAGE_OPERATION,
  fleetTriageInputSchema,
  fleetTriageReportSchema,
  type TriagePublication,
} from '@agent-lcars/dispatch-contracts';
import {
  type GithubAnchor,
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
} from '@agent-lcars/orchestrator';
import { ulid, workPayloadSchema } from '@agent-lcars/work';

import {
  loadTriageSource,
  triageDigest,
  triageEligible,
  triageFingerprint,
  type TriageSource,
  triageSourceKey,
} from './fleet-triage-source';
import { getWatchedRepos } from './watched-repos-config';

const TRIAGE_DESCRIPTION = `Investigate the single issue identified by the JSON context in this brief. This is read-only triage: do not change GitHub, files, labels, assignments, or PRs.
Read the target repository's current AGENTS.md and triage guidance, the issue and comments, linked PRs and current source. Follow duplicates and deployment evidence where relevant. Verify claims against current source and record its exact revision. Do not treat an ordinary investigation failure as a human decision.
Return only one JSON object (no fences) with exactly these required fields: sourceRevision copied exactly from context (1–128 characters), disposition (ready, needs-evidence, needs-owner, duplicate, or not-a-bug), summary (1–2000 characters), evidence (1–8 strings, each 1–1000 characters, with concrete source/URL references), acceptanceCriteria (0–8 strings, each 1–500 characters), and labels (0–12 existing type/component labels, each 1–100 characters, excluding bug/type:bug and all control labels). Include acceptanceCriteria: [] or labels: [] when there are none; never omit either field. All strings must be nonblank. Check every field and character limit before returning the JSON.
Use ready only for a confirmed defect with enough reproduction evidence to write a failing regression test, concrete acceptance criteria, bounded scope and no unresolved owner-only decision. The server will recheck ownership and publish approved effects; ready authorizes normal agent:opencode intake, never a redispatch. No closure or assignment change is proposed. Use needs-owner only for a specific decision or action that the owner genuinely controls. The final JSON report must fit 16384 characters.`;

export interface TriageRuntime {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
}

export async function reconcileFleetTriage(
  runtime: TriageRuntime,
  anchor: GithubAnchor,
  deleted = false,
): Promise<void> {
  const observedAt = new Date().toISOString();
  if (
    !deleted &&
    getWatchedRepos().some(
      (repo) =>
        `${repo.owner}/${repo.name}` === anchor.repo && repo.agents !== false,
    )
  ) {
    await admitFleetTriage(runtime, anchor);
    return;
  }
  const history = await readTriageHistory(runtime.store, anchor);
  if (history.latest === undefined) return;
  const result = await runtime.orchestrator.invalidateSource(
    history.latest.runId,
    { github: observedAt },
  );
  if (isRefusal(result))
    throw new Error(`Triage invalidation refused: ${result.reason}`);
}

export async function readTriageHistory(
  store: OrchestratorStore,
  anchor: GithubAnchor,
) {
  const workId = await store.readSourceWorkId(triageSourceKey(anchor));
  if (workId === undefined)
    return { workId, runs: [] as Run[], latest: undefined, owned: undefined };
  const runs = (await store.listRuns({ workId })).sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId.localeCompare(a.runId, undefined, { numeric: true }),
  );
  const owned = runs.find(
    (run) => run.triagePublication?.commentId !== undefined,
  )?.triagePublication;
  return { workId, runs, latest: runs[0], owned };
}

export async function admitFleetTriage(
  runtime: TriageRuntime,
  anchor: GithubAnchor,
  loadSource: (
    store: OrchestratorStore,
    anchor: GithubAnchor,
  ) => Promise<TriageSource> = loadTriageSource,
): Promise<void> {
  const source = await loadSource(runtime.store, anchor);
  const history = await readTriageHistory(runtime.store, anchor);
  const pending = history.latest?.triagePublication;
  if (!triageEligible(source)) {
    // The dispatch label is the final intended effect. Its read-back settles
    // publication; its own webhook must not cancel that receipt first.
    if (
      pending?.state === 'pending' &&
      pending.dispatchRequested &&
      source.labels.includes('agent:opencode')
    )
      return;
    if (history.latest !== undefined) {
      const invalidated = await runtime.orchestrator.invalidateSource(
        history.latest.runId,
        { github: source.observedAt },
      );
      if (isRefusal(invalidated))
        throw new Error(`Triage invalidation refused: ${invalidated.reason}`);
    }
    return;
  }
  // A publisher may have written its comment but not recorded the returned ID.
  // Keep this durable webhook retryable until the existing outbox reconciles it.
  if (pending?.state === 'pending')
    throw new Error('Triage publication is still reconciling');
  const input = fleetTriageInputSchema.parse({
    operation: FLEET_TRIAGE_OPERATION,
    ...anchor,
    fingerprint: triageFingerprint(source, history.owned),
  });
  const observedAt = { github: source.observedAt };
  const key = triageDigest({ input, observedAt });
  const workId =
    history.workId ??
    (await runtime.store.resolveSourceWorkId(triageSourceKey(anchor), ulid()));
  const work = workPayloadSchema.parse({
    origin: { principal: 'svc:fleet-triage', channel: 'github' },
    spec: {
      title: `Triage ${anchor.repo}#${anchor.issue}`,
      description: TRIAGE_DESCRIPTION,
      pipeline: 'opencode',
      priority: 'background',
      deliverable: 'report',
      target: { repo: anchor.repo },
    },
  });
  const admitted = await runtime.orchestrator.request({
    taskId: { workId },
    requestId: key,
    pipeline: 'opencode',
    priority: 'background',
    params: { mode: 'implement' },
    work,
    sourceRevision: { key, input, observedAt },
    isStoredWorkCompatible: (stored) => {
      const parsed = workPayloadSchema.safeParse(stored);
      return (
        parsed.success &&
        parsed.data.origin.principal === work.origin.principal &&
        parsed.data.spec.pipeline === 'opencode' &&
        parsed.data.spec.deliverable === 'report' &&
        parsed.data.spec.target.repo === anchor.repo
      );
    },
  });
  if (isRefusal(admitted) && admitted.reason !== 'duplicate-request')
    throw new Error(`Triage admission refused: ${admitted.reason}`);
}

export function triageBriefContext(run: Run): string | undefined {
  const input = fleetTriageInputSchema.safeParse(run.sourceRevision?.input);
  return input.success
    ? JSON.stringify({
        operation: FLEET_TRIAGE_OPERATION,
        repo: input.data.repo,
        issue: input.data.issue,
        sourceRevision: run.sourceRevision?.key,
      })
    : undefined;
}

export function parseTriageReport(run: Run, message: string | undefined) {
  const input = fleetTriageInputSchema.parse(run.sourceRevision?.input);
  const report = fleetTriageReportSchema.parse(JSON.parse(message ?? ''));
  if (report.sourceRevision !== run.sourceRevision?.key)
    throw new Error('Triage report revision changed');
  return { input, report };
}

/** Receipt mutations share the Run transaction and never replace a later
 * terminal state. External writes remain owned by the outbox lease. */
export async function recordTriagePublication(
  store: OrchestratorStore,
  runId: string,
  patch: Partial<TriagePublication>,
): Promise<Run | undefined> {
  const now = new Date().toISOString();
  const result = await store.transactRun({
    runId,
    decide: ({ task, run }) => {
      if (
        task === undefined ||
        run === undefined ||
        run.triagePublication === undefined
      )
        return { refused: true, reason: 'unknown-run' };
      if (run.triagePublication.state !== 'pending')
        return { task: task.task, run, outbox: [] };
      const stale = task.task.desiredRevision?.key !== run.sourceRevision?.key;
      const publication: TriagePublication = {
        ...run.triagePublication,
        ...patch,
        ...(stale ? { state: 'superseded' as const } : {}),
      };
      return {
        task: task.task,
        run: { ...run, triagePublication: publication, updatedAt: now },
        outbox: [],
      };
    },
  });
  if (isRefusal(result))
    throw new Error(`Triage receipt refused: ${result.reason}`);
  return result.run;
}
