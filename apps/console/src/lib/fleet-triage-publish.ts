import 'server-only';

import type {
  FleetTriageReport,
  TriageAnchor,
  TriagePublication,
} from '@agent-lcars/dispatch-contracts';
import type {
  LeasedOutboxEntry,
  OrchestratorStore,
  Run,
} from '@agent-lcars/orchestrator';

import {
  loadTriageSource,
  triageEligible,
  triageFingerprint,
  triageMarker,
  type TriageSource,
} from './fleet-triage-source';
import { hasTriageDispatchLabel } from './fleet-triage-source';
import { hasCodingHistory, triageTracker } from './fleet-triage-tracker';
import {
  parseTriageReport,
  readTriageHistory,
  recordTriagePublication,
} from './fleet-triage-work';

export function triageComment(
  run: Run,
  anchor: TriageAnchor,
  report: FleetTriageReport,
  dispatchedBefore = false,
): string {
  const body = `${triageMarker(anchor)}\n## LCARS issue triage\n\n${report.summary}\n\nDisposition: **${report.disposition}**\n\nEvidence:\n${report.evidence.map((line) => `- ${line}`).join('\n')}${report.acceptanceCriteria.length === 0 ? '' : `\n\nAcceptance criteria:\n${report.acceptanceCriteria.map((line) => `- ${line}`).join('\n')}`}\n\n[Work history](https://lcars.jlapenna.net/work/${'workId' in run.task ? run.task.workId : ''}) · revision \`${report.sourceRevision}\``;
  const published =
    body +
    (dispatchedBefore && report.disposition === 'ready'
      ? '\n\nA coding dispatch was already issued for this issue; no automatic redispatch.'
      : '');
  if (published.length > 16_384)
    throw new Error('Triage comment exceeds its result bound');
  return published;
}

export async function publishFleetTriage(
  store: OrchestratorStore,
  entry: LeasedOutboxEntry,
  loadSource = loadTriageSource,
): Promise<void> {
  let run = await store.readRun(entry.runId);
  if (run?.triagePublication?.state !== 'pending') return;
  const { input, report } = parseTriageReport(run, run.result?.message);
  const anchor: TriageAnchor =
    'source' in input
      ? { repo: input.repo, source: input.source }
      : { repo: input.repo, issue: input.issue };
  const tracker = await triageTracker(anchor);
  const marker = triageMarker(anchor);
  const history = await readTriageHistory(store, anchor);
  let dispatchedBefore =
    (await hasCodingHistory(store, anchor)) ||
    history.runs.some(
      (previous) =>
        previous.runId !== entry.runId &&
        previous.triagePublication?.dispatchObserved,
    );
  for (const previous of history.runs) {
    const requested = previous.triagePublication?.dispatchRequested;
    if (
      !dispatchedBefore &&
      previous.runId !== entry.runId &&
      requested !== undefined
    )
      dispatchedBefore = await tracker.dispatchObserved(requested);
  }
  const body = triageComment(run, anchor, report, dispatchedBefore);
  const checkLease = () => {
    if (Date.now() + 30_000 >= Date.parse(entry.leaseExpiresAt))
      throw new Error('Triage publisher lease has insufficient write budget');
  };
  const record = async (patch: Partial<TriagePublication>) => {
    run = await recordTriagePublication(store, entry.runId, patch);
    return run?.triagePublication?.state === 'pending';
  };
  const fresh = async (): Promise<TriageSource | undefined> => {
    const source = await loadSource(store, anchor);
    const history = await readTriageHistory(store, anchor);
    const owned = history.runs.find((candidate) =>
      source.comments.some(
        (comment) =>
          comment.id === candidate.triagePublication?.commentId &&
          comment.body === candidate.triagePublication.commentBody,
      ),
    )?.triagePublication;
    if (
      !triageEligible(source) ||
      triageFingerprint(source, owned) !== input.fingerprint
    ) {
      await record({ state: 'superseded' });
      return undefined;
    }
    // Recheck the desired revision transactionally after the remote read.
    if (!(await record({}))) return undefined;
    checkLease();
    return source;
  };

  let source: TriageSource | undefined = await loadSource(store, anchor);
  const intent = run.triagePublication.dispatchRequested;
  if (
    intent !== undefined &&
    (hasTriageDispatchLabel(source) || (await tracker.dispatchObserved(intent)))
  ) {
    await record({ dispatchObserved: true, state: 'complete' });
    return;
  }
  // Recover a successful create whose response/receipt was lost. The exact
  // intended body includes this Work and revision, not merely a copied marker.
  if (
    run.triagePublication.commentBody !== undefined &&
    run.triagePublication.commentId === undefined
  ) {
    const recovered = source.comments.filter(
      (comment) => comment.body === run?.triagePublication?.commentBody,
    );
    if (recovered.length > 1)
      throw new Error('Ambiguous triage comment read-back');
    if (
      recovered[0] !== undefined &&
      !(await record({ commentId: recovered[0].id }))
    )
      return;
  }
  source = await fresh();
  if (source === undefined) return;

  const labels = await tracker.labels();
  const allowed = new Map(
    labels
      .filter(
        (label) =>
          /^(type|component|app):/u.test(label.name) &&
          label.name !== 'type:bug',
      )
      .map((label) => [label.name, label.id]),
  );
  if (report.labels.some((label) => !allowed.has(label))) {
    await record({
      state: 'failed',
      error: 'Report proposed an unavailable or non-metadata label',
    });
    return;
  }
  const existingLabels = new Set(source.labels);
  const missing = report.labels.filter((label) => !existingLabels.has(label));
  if (missing.length > 0) {
    if (
      !(await record({
        addedLabels: [
          ...new Set([
            ...(run?.triagePublication?.addedLabels ?? []),
            ...missing,
          ]),
        ],
      }))
    )
      return;
    source = await fresh();
    if (source === undefined) return;
    await tracker.addLabels(
      missing.map((label) => allowed.get(label) as string),
    );
    source = await fresh();
    if (source === undefined) return;
    if (missing.some((label) => !source?.labels.includes(label)))
      throw new Error('Triage metadata labels not observed');
  }

  const marked = source.comments.filter((comment) =>
    comment.body.includes(marker),
  );
  if (marked.length > 1) throw new Error('More than one marked triage comment');
  const current = marked[0];
  if (current?.body !== body) {
    const history = await readTriageHistory(store, anchor);
    const previous = history.runs.find(
      (candidate) =>
        candidate.triagePublication?.commentId === current?.id &&
        candidate.triagePublication?.commentBody === current?.body,
    )?.triagePublication;
    const sourceComment =
      previous === undefined ? current : previous.sourceComment;
    if (
      !(await record({
        commentBody: body,
        ...(current === undefined ? {} : { commentId: current.id }),
        ...(sourceComment === undefined ? {} : { sourceComment }),
      }))
    )
      return;
    source = await fresh();
    if (source === undefined) return;
    const posted = await tracker.writeComment(body, current?.id);
    if (!(await record({ commentId: posted }))) return;
  }
  const commentId = run?.triagePublication?.commentId ?? current?.id;
  if (commentId === undefined)
    throw new Error('Triage comment receipt missing');
  if ((await tracker.readComment(commentId)) !== body)
    throw new Error('Triage comment read-back changed');
  if (report.disposition !== 'ready' || dispatchedBefore) {
    await record({ state: 'complete' });
    return;
  }

  source = await fresh();
  if (source === undefined) return;
  // A manually requested coding run can settle while this report publishes.
  // Its removed control labels do not authorize another automatic dispatch.
  if (await hasCodingHistory(store, anchor)) {
    await record({ state: 'complete' });
    return;
  }
  if (
    !(await record({
      dispatchRequested:
        run?.triagePublication?.dispatchRequested ?? new Date().toISOString(),
    }))
  )
    return;
  checkLease();
  await tracker.addLabels([tracker.dispatchLabel]);
  const dispatched = await loadSource(store, anchor);
  if (!hasTriageDispatchLabel(dispatched))
    throw new Error('Triage dispatch label not observed');
  await record({ dispatchObserved: true, state: 'complete' });
}
