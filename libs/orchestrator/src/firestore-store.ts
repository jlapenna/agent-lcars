import {
  type IssueReference,
  issueSourceKey,
  plainRunEvidence,
  type RunEvidence,
  runEvidenceSchema,
  type TrackerIssue,
  type TrackerIssueProjection,
  trackerIssueProjectionSchema,
  trackerIssueSchema,
} from '@agent-lcars/dispatch-contracts';
import {
  type CollectionReference,
  type DocumentReference,
  FieldPath,
  FieldValue,
  Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import { z } from 'zod';

import {
  claimQueuedRun,
  type Decision,
  isRefusal,
  type Refusal,
} from './decide';
import { prepareIssueSnapshot } from './issue-snapshot';
import { itemStateEventOutbox, taskDerivedFrom } from './item-state';
import {
  type LifecycleMetricRead,
  type LifecycleMetricRecords,
  validateLifecycleMetricRead,
} from './lifecycle-metrics';
import {
  byOutboxClaimFairness,
  GITHUB_ANCHOR_MERGE_EVIDENCE_FIELDS,
  type GithubAnchorMergeEvidence,
  githubAnchorMergeEvidenceSchema,
  type GithubAnchorProjection,
  githubAnchorProjectionSchema,
  githubAnchorSchema,
  isClaimant,
  isLive,
  issueSnapshotIdSchema,
  isWorkAnchor,
  type LeasedOutboxEntry,
  type OutboxEntry,
  outboxEntrySchema,
  type OutboxSettlement,
  queueOrderAt,
  type RequestSource,
  type Run,
  runIssueSnapshotSchema,
  type RunMessageOverflow,
  runRecoveryDeadline,
  runSchema,
  runStateSchema,
  settleOutboxEntry,
  type Task,
  type TaskDerived,
  taskDocumentSchema,
  type TaskId,
  taskIdSchema,
  taskKey,
  wakeOutboxEntry,
  type WorkRevision,
  workRevisionSchema,
} from './model';
import {
  type ProviderCooldown,
  providerCooldownForRun,
  providerIsCoolingDown,
  shouldWriteProviderCooldown,
} from './provider-cooldown';
import { retainsPhysicalClaim } from './provider-routing';
import {
  parseCredentialWindow,
  parseProviderCooldown,
  projectQueueAdmissionStatus,
  type ProviderCredentialWindow,
} from './queue-admission-status';
import { joinRunMessage } from './run-message';
import {
  type OpenGithubAnchorProjectionCursor,
  type OpenGithubAnchorProjectionPage,
  type OrchestratorStore,
  queuePriorityCursorSchema,
  queuePriorityTurnAfter,
  type RequestBinding,
  type RequestTransactionState,
  type RunListCursor,
  type RunRef,
  type RunTransactionState,
  selectFairQueuedRun,
  StoreConflict,
  type TaskListCursor,
  type TaskSortKey,
  type VersionedTask,
} from './store';

/** The two fields `listRunRefsWithSummary` projects from a run document. */
const runRefSchema = z.object({
  task: taskIdSchema,
  updatedAt: z.iso.datetime({ offset: false }),
});

/** Live states, derived from the schema rather than re-listed by hand so it
 *  can never drift from `model.ts`'s own notion of "live". */
const LIVE_STATES = runStateSchema.options.filter(isLive);

/** Documents per query page for reads that must see every match (metrics,
 * admission status, physical-claim inventory). It bounds one round trip, not
 * the result: `readAllPages` follows the cursor until the query is exhausted. */
export const FIRESTORE_READ_PAGE_SIZE = 1000;

/** Every document `query` matches, read `pageSize` at a time. `get` runs each
 * page, so a transaction can read all pages under its own snapshot. */
async function readAllPages(
  query: Query,
  pageSize: number,
  get: (page: Query) => Promise<QuerySnapshot> = (page) => page.get(),
): Promise<QueryDocumentSnapshot[]> {
  const docs: QueryDocumentSnapshot[] = [];
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await get(
      (last === undefined ? query : query.startAfter(last)).limit(pageSize),
    );
    docs.push(...page.docs);
    last = page.docs.at(-1);
    if (page.size < pageSize || last === undefined) return docs;
  }
}

const taskDocSchema = taskDocumentSchema;
const requestBindingSchema = z.strictObject({
  canonicalRequestId: z.string().min(1).max(512),
  firstSourceRequestId: z.string().min(1).max(512),
});

export interface FirestoreStoreOptions {
  readonly projectId: string;
  readonly databaseId: string;
  /** Defaults to `orchestrator-`. Collections are `<prefix>tasks`,
   *  `<prefix>runs`, `<prefix>issue-snapshots`, `<prefix>outbox`,
   *  `<prefix>request-bindings`,
   *  `<prefix>github-anchors`, `<prefix>provider-cooldowns`, and
   *  `<prefix>priority-positions`. */
  readonly collectionPrefix?: string;
  /** Set to talk to a local Firestore emulator instead of the real service. */
  readonly emulatorHost?: string;
  /** Page size for exhaustive reads; defaults to
   *  {@link FIRESTORE_READ_PAGE_SIZE}. Tests lower it to exercise paging. */
  readonly readPageSize?: number;
}

/** gRPC ALREADY_EXISTS: what creating a document that exists fails with. */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 6
  );
}

/**
 * Firestore-backed `OrchestratorStore`. No caching, no cleverness: every
 * method is a direct read or write against the collections below, matching
 * `MemoryStore`'s observable behaviour.
 *
 * Document ids: `/` cannot appear in a Firestore document id, but
 * `taskKey()` and run/outbox ids all contain one (`repo#issue`,
 * `repo#issue/rN`, `dispatch/repo#issue/rN`, ...), so every id is
 * `encodeURIComponent`-ed before use as a document id, consistently on both
 * write and read.
 */
/** The stored item state for a task write: derived from the task's runs as
 * they will be once `written` (each replacing its stored copy by run id)
 * commits, or absent when the stored runs could not all be read. With it,
 * the `agent-event` outbox entry when the write changes a native Work item's
 * state (#3568), written in the same transaction. */
function taskWrite(input: {
  previous: Task | undefined;
  task: Task;
  stored: readonly Run[] | undefined;
  written: readonly (Run | undefined)[];
  revision: number;
}): { stored: { derived?: TaskDerived }; events: OutboxEntry[] } {
  const { previous, task, stored, written, revision } = input;
  if (stored === undefined) return { stored: {}, events: [] };
  const runs = new Map(stored.map((run) => [run.runId, run]));
  for (const run of written) if (run !== undefined) runs.set(run.runId, run);
  const next = [...runs.values()];
  return {
    stored: { derived: taskDerivedFrom(task, next) },
    events: itemStateEventOutbox({
      previous: { task: previous, runs: stored },
      next: { task, runs: next },
      revision,
    }),
  };
}

export class FirestoreStore implements OrchestratorStore {
  readonly #firestore: Firestore;
  readonly #tasks: CollectionReference;
  readonly #runs: CollectionReference;
  readonly #issueSnapshots: CollectionReference;
  readonly #outbox: CollectionReference;
  readonly #sourceWorkIds: CollectionReference;
  readonly #requestBindings: CollectionReference;
  readonly #githubAnchors: CollectionReference;
  readonly #trackerIssues: CollectionReference;
  readonly #providerCooldowns: CollectionReference;
  readonly #credentialWindows: CollectionReference;
  readonly #priorityPositions: CollectionReference;
  readonly #readPageSize: number;

  constructor(options: FirestoreStoreOptions) {
    this.#readPageSize = options.readPageSize ?? FIRESTORE_READ_PAGE_SIZE;
    if (!Number.isInteger(this.#readPageSize) || this.#readPageSize < 1)
      throw new Error('readPageSize must be a positive integer');
    const prefix = options.collectionPrefix ?? 'orchestrator-';
    const firestoreOptions = {
      projectId: options.projectId,
      databaseId: options.databaseId,
      ...(options.emulatorHost === undefined
        ? {}
        : { host: options.emulatorHost, ssl: false }),
    };
    this.#firestore = new Firestore(firestoreOptions);
    this.#sourceWorkIds = this.#firestore.collection(`${prefix}work-sources`);
    this.#tasks = this.#firestore.collection(`${prefix}tasks`);
    this.#runs = this.#firestore.collection(`${prefix}runs`);
    this.#issueSnapshots = this.#firestore.collection(
      `${prefix}issue-snapshots`,
    );
    this.#outbox = this.#firestore.collection(`${prefix}outbox`);
    this.#requestBindings = this.#firestore.collection(
      `${prefix}request-bindings`,
    );
    this.#githubAnchors = this.#firestore.collection(`${prefix}github-anchors`);
    this.#trackerIssues = this.#firestore.collection(`${prefix}issue-sources`);
    this.#providerCooldowns = this.#firestore.collection(
      `${prefix}provider-cooldowns`,
    );
    this.#credentialWindows = this.#firestore.collection(
      `${prefix}provider-credential-windows`,
    );
    this.#priorityPositions = this.#firestore.collection(
      `${prefix}priority-positions`,
    );
  }

  async #prepareProviderCooldownWrites(
    tx: Transaction,
    runs: readonly (Run | undefined)[],
  ): Promise<ProviderCooldown[]> {
    const candidates: ProviderCooldown[] = [];
    for (const run of runs) {
      if (run === undefined) continue;
      const cooldown = providerCooldownForRun(run);
      if (cooldown !== undefined) candidates.push(cooldown);
    }
    if (candidates.length === 0) return [];
    const pipelines = [...new Set(candidates.map((c) => c.pipeline))];
    const snapshots = await Promise.all(
      pipelines.map((pipeline) =>
        tx.get(this.#providerCooldowns.doc(encodeURIComponent(pipeline))),
      ),
    );
    const effective = new Map<string, unknown>(
      pipelines.map((pipeline, index) => [pipeline, snapshots[index]?.data()]),
    );
    const writes = new Map<string, ProviderCooldown>();
    for (const candidate of candidates) {
      if (
        shouldWriteProviderCooldown(
          effective.get(candidate.pipeline),
          candidate,
        )
      ) {
        effective.set(candidate.pipeline, candidate);
        writes.set(candidate.pipeline, candidate);
      }
    }
    return [...writes.values()];
  }

  #commitProviderCooldownWrites(
    tx: Transaction,
    writes: readonly ProviderCooldown[],
  ): void {
    for (const cooldown of writes) {
      tx.set(
        this.#providerCooldowns.doc(encodeURIComponent(cooldown.pipeline)),
        cooldown,
      );
    }
  }

  async readTask(id: TaskId): Promise<VersionedTask | undefined> {
    const snapshot = await this.#taskRef(id).get();
    return snapshot.exists ? taskDocSchema.parse(snapshot.data()) : undefined;
  }

  /** Firestore batches a `getAll` itself, but the request bound grows with the
   * ref count, so the console's hundred-task pages are read in chunks of this
   * size rather than as one oversized document read. */
  static readonly #getAllSize = 100;

  async readTasks(ids: readonly TaskId[]): Promise<Map<string, VersionedTask>> {
    const entries = [
      ...new Map(ids.map((id) => [taskKey(id), this.#taskRef(id)])).entries(),
    ];
    const chunked: [string, DocumentReference][][] = [];
    for (
      let offset = 0;
      offset < entries.length;
      offset += FirestoreStore.#getAllSize
    )
      chunked.push(entries.slice(offset, offset + FirestoreStore.#getAllSize));
    const found = new Map<string, VersionedTask>();
    const got = await Promise.all(
      chunked.map((chunk) =>
        this.#firestore.getAll(...chunk.map(([, ref]) => ref)),
      ),
    );
    got.forEach((snapshots, chunkIndex) =>
      snapshots.forEach((snapshot, position) => {
        const key = chunked[chunkIndex]?.[position]?.[0];
        if (key !== undefined && snapshot.exists)
          found.set(key, taskDocSchema.parse(snapshot.data()));
      }),
    );
    return found;
  }

  async readLifecycleMetricRecords(
    input: LifecycleMetricRead,
  ): Promise<LifecycleMetricRecords> {
    validateLifecycleMetricRead(input);
    // Automatic single-field indexes only: no infra change or full-table
    // read. Each feed is read to exhaustion so no metric is computed from a
    // truncated window.
    const [recent, live, outbox] = await Promise.all([
      readAllPages(
        this.#runs
          .where('updatedAt', '>=', input.since)
          .where('updatedAt', '<=', input.until),
        this.#readPageSize,
      ),
      readAllPages(
        this.#runs.where('state', 'in', LIVE_STATES),
        this.#readPageSize,
      ),
      readAllPages(
        this.#outbox.where('state', 'in', ['pending', 'leased', 'failed']),
        this.#readPageSize,
      ),
    ]);
    return {
      recentRuns: recent.map((doc) => runSchema.parse(doc.data())),
      liveRuns: live.map((doc) => runSchema.parse(doc.data())),
      outstandingOutbox: outbox.map((doc) =>
        outboxEntrySchema.parse(doc.data()),
      ),
      complete: true,
    };
  }

  async readIssueSnapshot(id: string): Promise<TrackerIssue | undefined> {
    const doc = await this.#issueSnapshots
      .doc(issueSnapshotIdSchema.parse(id))
      .get();
    return doc.exists ? trackerIssueSchema.parse(doc.get('issue')) : undefined;
  }

  async readIssueSnapshots(
    ids: readonly string[],
  ): Promise<Map<string, TrackerIssue>> {
    const unique = [...new Set(ids)];
    const result = new Map<string, TrackerIssue>();
    for (let index = 0; index < unique.length; index += this.#readPageSize) {
      const docs = await this.#firestore.getAll(
        ...unique
          .slice(index, index + this.#readPageSize)
          .map((id) =>
            this.#issueSnapshots.doc(issueSnapshotIdSchema.parse(id)),
          ),
      );
      for (const doc of docs) {
        if (doc.exists)
          result.set(doc.id, trackerIssueSchema.parse(doc.get('issue')));
      }
    }
    return result;
  }

  async #writeIssueSnapshot(
    tx: Transaction,
    snapshot: Decision['newIssueSnapshot'],
  ): Promise<void> {
    if (snapshot === undefined) return;
    const ref = this.#issueSnapshots.doc(snapshot.reference.id);
    if (!(await tx.get(ref)).exists) tx.create(ref, { issue: snapshot.issue });
  }

  /**
   * Backfill a bounded page, re-reading candidates in their write transaction.
   * The document ID cursor can be persisted after each successful page.
   */
  async migrateRunIssueSnapshots(input: {
    apply: boolean;
    cursor?: string;
  }): Promise<{
    scanned: number;
    candidates: number;
    migrated: number;
    nextCursor?: string;
  }> {
    const pageSize = Math.min(this.#readPageSize, 200);
    const query = this.#runs.orderBy(FieldPath.documentId()).select('issue');
    const page = await (
      input.cursor === undefined ? query : query.startAfter(input.cursor)
    )
      .limit(pageSize)
      .get();
    const candidates = page.docs.filter(
      (doc) => doc.get('issue') !== undefined,
    );
    let migrated = 0;
    if (input.apply) {
      for (const candidate of candidates) {
        const changed = await this.#firestore.runTransaction(async (tx) => {
          const current = await tx.get(candidate.ref);
          const legacy: unknown = current.get('issue');
          if (legacy === undefined) return false;
          const snapshot = prepareIssueSnapshot(legacy);
          const reference: unknown = current.get('issueSnapshot');
          if (
            reference !== undefined &&
            runIssueSnapshotSchema.parse(reference).id !== snapshot.reference.id
          ) {
            throw new Error(
              `Conflicting issue snapshots on run document ${current.id}`,
            );
          }
          await this.#writeIssueSnapshot(tx, snapshot);
          tx.update(candidate.ref, {
            issue: FieldValue.delete(),
            issueSnapshot: snapshot.reference,
          });
          return true;
        });
        if (changed) migrated += 1;
      }
    }
    const nextCursor =
      page.size === pageSize ? page.docs.at(-1)?.id : undefined;
    return {
      scanned: page.size,
      candidates: candidates.length,
      migrated,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async writeRunMessage(input: {
    runId: string;
    overflow: RunMessageOverflow;
    chunks: readonly string[];
  }): Promise<void> {
    // One commit: the chunks stay well under Firestore's 10 MiB request
    // bound because the message itself is bounded by RUN_MESSAGE_MAX_BYTES.
    const batch = this.#firestore.batch();
    input.chunks.forEach((text, index) =>
      batch.set(this.#runMessageChunkRef(input.runId, input.overflow, index), {
        sha256: input.overflow.sha256,
        index,
        count: input.chunks.length,
        text,
      }),
    );
    await batch.commit();
  }

  async readRunMessage(input: {
    runId: string;
    overflow: RunMessageOverflow;
  }): Promise<string | undefined> {
    const snapshots = await this.#firestore.getAll(
      ...Array.from({ length: input.overflow.chunks }, (_, index) =>
        this.#runMessageChunkRef(input.runId, input.overflow, index),
      ),
    );
    return joinRunMessage(
      input.overflow,
      snapshots.map((snapshot) => {
        const text: unknown = snapshot.get('text');
        return snapshot.exists && typeof text === 'string' ? text : undefined;
      }),
    );
  }

  async writeRunEvidence(input: {
    runId: string;
    claimFingerprint: string;
    evidence: RunEvidence;
  }): Promise<boolean> {
    try {
      // One create, outside any transaction: it reads and locks nothing, so
      // it can never make the run's completion wait. Firestore refuses a
      // document with a key left `undefined`, which a cost that was left
      // out of the record is.
      await this.#runEvidenceRef(input.runId, input.claimFingerprint).create(
        plainRunEvidence(input.evidence),
      );
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  async readRunEvidence(
    runs: readonly Pick<Run, 'runId' | 'queue'>[],
  ): Promise<Map<string, RunEvidence>> {
    const found = new Map<string, RunEvidence>();
    const claimed = runs.flatMap((run) =>
      run.queue?.tokenHash === undefined
        ? []
        : [{ runId: run.runId, claim: run.queue.tokenHash }],
    );
    if (claimed.length === 0) return found;
    const snapshots = await this.#firestore.getAll(
      ...claimed.map(({ runId, claim }) => this.#runEvidenceRef(runId, claim)),
    );
    snapshots.forEach((snapshot, index) => {
      // Evidence is a reading aid: a document this Console cannot parse is
      // left out rather than failing the read of its run.
      const evidence = runEvidenceSchema.safeParse(snapshot.data());
      const runId = claimed[index]?.runId;
      if (snapshot.exists && evidence.success && runId !== undefined)
        found.set(runId, plainRunEvidence(evidence.data));
    });
    return found;
  }

  async readRun(runId: string): Promise<Run | undefined> {
    const snapshot = await this.#runRef(runId).get();
    return snapshot.exists ? runSchema.parse(snapshot.data()) : undefined;
  }

  async readActiveRun(id: TaskId): Promise<Run | undefined> {
    const task = await this.readTask(id);
    const activeRunId = task?.task.activeRunId;
    return activeRunId === undefined ? undefined : this.readRun(activeRunId);
  }

  async listRuns(id: TaskId): Promise<Run[]> {
    const snapshot = await this.#runsForTask(id).get();
    return snapshot.docs.map((doc) => runSchema.parse(doc.data()));
  }

  /** Firestore's ceiling on the disjuncts of one `in` filter. */
  static readonly #inFilterSize = 30;

  async listRunsForTasks(ids: readonly TaskId[]): Promise<Map<string, Run[]>> {
    const keys = new Set<string>();
    const workIds: string[] = [];
    const issuesByRepo = new Map<string, number[]>();
    for (const id of ids) {
      const key = taskKey(id);
      if (keys.has(key)) continue;
      keys.add(key);
      if (isWorkAnchor(id)) workIds.push(id.workId);
      else
        issuesByRepo.set(id.repo, [
          ...(issuesByRepo.get(id.repo) ?? []),
          id.issue,
        ]);
    }

    const runs = new Map<string, Run[]>([...keys].map((key) => [key, []]));
    const queries: Query[] = [];
    for (
      let offset = 0;
      offset < workIds.length;
      offset += FirestoreStore.#inFilterSize
    )
      queries.push(
        this.#runs.where(
          'task.workId',
          'in',
          workIds.slice(offset, offset + FirestoreStore.#inFilterSize),
        ),
      );
    for (const [repo, issues] of issuesByRepo)
      for (
        let offset = 0;
        offset < issues.length;
        offset += FirestoreStore.#inFilterSize
      )
        queries.push(
          this.#runs
            .where('task.repo', '==', repo)
            .where(
              'task.issue',
              'in',
              issues.slice(offset, offset + FirestoreStore.#inFilterSize),
            ),
        );

    // One query per bounded chunk rather than one per task: the same
    // equality-only shape `#runsForTask` stays on, so this needs no new
    // composite index. A chunk's `in` disjuncts can each miss, so a chunk
    // returning nothing still leaves its tasks mapped to the empty list.
    const pages = await Promise.all(queries.map((query) => query.get()));
    for (const page of pages)
      for (const doc of page.docs) {
        const run = runSchema.parse(doc.data());
        const key = taskKey(run.task);
        const bucket = runs.get(key);
        if (bucket) bucket.push(run);
      }
    return runs;
  }

  async transactRequest(input: {
    taskId: TaskId;
    requestId: string;
    requestSource: RequestSource;
    requestBinding?: RequestBinding;
    readProviderRouting?: boolean;
    readGithubProjection?: boolean;
    sourceRevision?: WorkRevision;
    decide(state: RequestTransactionState): Decision | Refusal;
  }): Promise<Decision | Refusal> {
    const taskRef = this.#taskRef(input.taskId);
    const revisionRef =
      input.sourceRevision === undefined
        ? undefined
        : taskRef
            .collection('source-revisions')
            .doc(encodeURIComponent(input.sourceRevision.key));
    const bindingRef =
      input.requestBinding === undefined
        ? undefined
        : this.#requestBindingRef(
            input.taskId,
            input.requestBinding.bindingKey,
          );
    return this.#firestore.runTransaction(async (tx) => {
      // The exact-key history query and the task/run reads share this
      // transaction with the accepted write. Firestore reruns the callback
      // if any concurrent request or settlement changes one of those reads,
      // closing the terminal-settlement replay window as well as the live-run
      // race without scanning the task's unbounded run history.
      const [taskSnapshot, bindingSnapshot, revisionSnapshot] =
        await Promise.all([
          tx.get(taskRef),
          bindingRef === undefined
            ? Promise.resolve(undefined)
            : tx.get(bindingRef),
          revisionRef === undefined
            ? Promise.resolve(undefined)
            : tx.get(revisionRef),
        ]);
      const task = taskSnapshot.exists
        ? taskDocSchema.parse(taskSnapshot.data())
        : undefined;
      const binding =
        bindingSnapshot === undefined || !bindingSnapshot.exists
          ? undefined
          : requestBindingSchema.parse(bindingSnapshot.data());
      let requestId = input.requestId;
      let bindingToCreate: z.infer<typeof requestBindingSchema> | undefined;
      if (input.requestBinding !== undefined) {
        if (binding === undefined) {
          requestId = input.requestBinding.canonicalRequestId;
          bindingToCreate = {
            canonicalRequestId: input.requestBinding.canonicalRequestId,
            firstSourceRequestId: input.requestId,
          };
        } else {
          if (
            binding.canonicalRequestId !==
            input.requestBinding.canonicalRequestId
          ) {
            throw new Error('request binding canonical identity mismatch');
          }
          if (binding.firstSourceRequestId === input.requestId) {
            requestId = binding.canonicalRequestId;
          }
        }
      }
      const [activeRunSnapshot, runsSnapshot] = await Promise.all([
        task?.task.activeRunId === undefined
          ? Promise.resolve(undefined)
          : tx.get(this.#runRef(task.task.activeRunId)),
        tx.get(
          this.#runsForRequest(input.taskId, requestId, input.requestSource),
        ),
      ]);
      const activeRun =
        activeRunSnapshot === undefined || !activeRunSnapshot.exists
          ? undefined
          : runSchema.parse(activeRunSnapshot.data());
      const previousRun = runsSnapshot.docs
        .map((doc) => runSchema.parse(doc.data()))
        .find((run) => run.requestSource === input.requestSource);
      const routing =
        input.readProviderRouting && task !== undefined
          ? await Promise.all([
              tx.get(
                this.#runRef(`${taskKey(input.taskId)}/r${task.task.runCount}`),
              ),
              readAllPages(
                this.#runsForTask(input.taskId).where(
                  'queue.state',
                  '==',
                  'claimed',
                ),
                this.#readPageSize,
                (page) => tx.get(page),
              ),
            ])
          : undefined;
      const previousSourceRevision = revisionSnapshot?.exists
        ? workRevisionSchema.parse(revisionSnapshot.data())
        : undefined;
      const githubProjection =
        input.readGithubProjection && !isWorkAnchor(input.taskId)
          ? (await tx.get(this.#githubAnchorRef(input.taskId))).data()?.[
              'projection'
            ]
          : undefined;
      const outcome = input.decide({
        previousSourceRevision,
        ...(githubProjection === undefined
          ? {}
          : {
              githubProjection:
                githubAnchorProjectionSchema.parse(githubProjection),
            }),
        ...(routing === undefined
          ? {}
          : {
              latestRun: routing[0].exists
                ? runSchema.parse(routing[0].data())
                : undefined,
              // Read every claimed candidate, page by page in this
              // transaction: an older remnant must not hide a later
              // credential owner behind a bounded read.
              retainedClaims: routing[1]
                .map((doc) => runSchema.parse(doc.data()))
                .filter((run) => retainsPhysicalClaim(run)),
            }),
        task,
        activeRun,
        requestId,
        previousRun,
      });
      const storedRuns = isRefusal(outcome)
        ? undefined
        : await this.#taskRunsIn(tx, outcome.task.task);
      const cooldownWrites = isRefusal(outcome)
        ? []
        : await this.#prepareProviderCooldownWrites(tx, [
            outcome.run,
            ...(outcome.additionalRuns ?? []),
          ]);
      if (!isRefusal(outcome))
        await this.#writeIssueSnapshot(tx, outcome.newIssueSnapshot);
      if (bindingToCreate !== undefined && bindingRef !== undefined) {
        tx.create(bindingRef, bindingToCreate);
      }
      if (isRefusal(outcome)) return outcome;
      if (
        revisionRef !== undefined &&
        input.sourceRevision !== undefined &&
        previousSourceRevision === undefined &&
        outcome.task.desiredRevision?.key === input.sourceRevision.key
      )
        tx.create(revisionRef, input.sourceRevision);

      const revision = (task?.revision ?? 0) + 1;
      const written = taskWrite({
        previous: task?.task,
        task: outcome.task,
        stored: storedRuns,
        written: [outcome.run, ...(outcome.additionalRuns ?? [])],
        revision,
      });
      const nextTaskDoc: z.infer<typeof taskDocSchema> = {
        task: outcome.task,
        revision,
        ...written.stored,
      };
      tx.set(taskRef, nextTaskDoc);
      if (outcome.run !== undefined) {
        tx.set(this.#runRef(outcome.run.runId), outcome.run);
      }
      for (const run of outcome.additionalRuns ?? []) {
        tx.set(this.#runRef(run.runId), run);
      }
      this.#commitProviderCooldownWrites(tx, cooldownWrites);
      for (const entry of [...outcome.outbox, ...written.events]) {
        tx.set(this.#outboxRef(entry.entryId), entry);
      }
      return outcome;
    });
  }

  async apply(input: {
    decision: Decision;
    expectedRevision: number | undefined;
  }): Promise<void> {
    const { decision, expectedRevision } = input;
    const taskRef = this.#taskRef(decision.task.task);

    return this.#firestore.runTransaction(async (tx) => {
      // All reads before all writes, per Firestore transaction rules. Run/
      // outbox refs are computed below, after the read -- ref construction
      // isn't itself a read, so this still respects that ordering.
      const taskSnapshot = await tx.get(taskRef);
      const current = taskSnapshot.exists
        ? taskDocSchema.parse(taskSnapshot.data())
        : undefined;
      const currentRevision = current?.revision;
      if (currentRevision !== expectedRevision) {
        throw new StoreConflict(decision.task.task);
      }
      const storedRuns = await this.#taskRunsIn(tx, decision.task.task);
      const cooldownWrites = await this.#prepareProviderCooldownWrites(tx, [
        decision.run,
        ...(decision.additionalRuns ?? []),
      ]);

      await this.#writeIssueSnapshot(tx, decision.newIssueSnapshot);
      const revision = (expectedRevision ?? 0) + 1;
      const written = taskWrite({
        previous: current?.task,
        task: decision.task,
        stored: storedRuns,
        written: [decision.run, ...(decision.additionalRuns ?? [])],
        revision,
      });
      const nextTaskDoc: z.infer<typeof taskDocSchema> = {
        task: decision.task,
        revision,
        ...written.stored,
      };
      tx.set(taskRef, nextTaskDoc);

      if (decision.run !== undefined) {
        tx.set(this.#runRef(decision.run.runId), decision.run);
      }
      for (const run of decision.additionalRuns ?? []) {
        tx.set(this.#runRef(run.runId), run);
      }
      this.#commitProviderCooldownWrites(tx, cooldownWrites);
      for (const entry of [...decision.outbox, ...written.events]) {
        tx.set(this.#outboxRef(entry.entryId), entry);
      }
    });
  }

  async transactRun(input: {
    runId: string;
    queueEligibilityPipelines?: readonly string[];
    shouldReadQueueEligibility?: (
      state: Pick<RunTransactionState, 'task' | 'run'>,
    ) => boolean;
    decide(state: RunTransactionState): Decision | Refusal;
  }): Promise<Decision | Refusal> {
    const runRef = this.#runRef(input.runId);
    return this.#firestore.runTransaction(async (tx) => {
      const runSnapshot = await tx.get(runRef);
      const run = runSnapshot.exists
        ? runSchema.parse(runSnapshot.data())
        : undefined;
      const taskRef = run === undefined ? undefined : this.#taskRef(run.task);
      const taskSnapshot =
        taskRef === undefined ? undefined : await tx.get(taskRef);
      const task =
        taskSnapshot === undefined || !taskSnapshot.exists
          ? undefined
          : taskDocSchema.parse(taskSnapshot.data());
      let queueEligibility: RunTransactionState['queueEligibility'];
      if (
        input.queueEligibilityPipelines !== undefined &&
        input.shouldReadQueueEligibility?.({ task, run }) !== false
      ) {
        const pipelines = [...new Set(input.queueEligibilityPipelines)];
        const [cooldowns, windows, live] = await Promise.all([
          Promise.all(
            pipelines.map((pipeline) =>
              tx.get(this.#providerCooldowns.doc(encodeURIComponent(pipeline))),
            ),
          ),
          Promise.all(
            pipelines.map((pipeline) =>
              tx.get(this.#credentialWindows.doc(encodeURIComponent(pipeline))),
            ),
          ),
          Promise.all(
            pipelines.flatMap((pipeline) =>
              LIVE_STATES.map((state) =>
                tx.get(
                  this.#runs
                    .where('pipeline', '==', pipeline)
                    .where('state', '==', state),
                ),
              ),
            ),
          ),
        ]);
        queueEligibility = {
          cooldowns: Object.fromEntries(
            pipelines.map((pipeline, index) => [
              pipeline,
              cooldowns[index]?.data(),
            ]),
          ),
          credentialWindows: Object.fromEntries(
            pipelines.map((pipeline, index) => [
              pipeline,
              windows[index]?.data(),
            ]),
          ),
          liveRuns: live.flatMap((snapshot) =>
            snapshot.docs.map((doc) => runSchema.parse(doc.data())),
          ),
        };
      }
      const outcome = input.decide({ task, run, queueEligibility });
      if (isRefusal(outcome)) return outcome;

      if (taskRef === undefined) {
        throw new Error('run transaction decision has no task reference');
      }
      const storedRuns = await this.#taskRunsIn(tx, outcome.task.task);
      const cooldownWrites = await this.#prepareProviderCooldownWrites(tx, [
        outcome.run,
        ...(outcome.additionalRuns ?? []),
      ]);
      await this.#writeIssueSnapshot(tx, outcome.newIssueSnapshot);
      const revision = (task?.revision ?? 0) + 1;
      const written = taskWrite({
        previous: task?.task,
        task: outcome.task,
        stored: storedRuns,
        written: [outcome.run, ...(outcome.additionalRuns ?? [])],
        revision,
      });
      tx.set(taskRef, { task: outcome.task, revision, ...written.stored });
      if (outcome.run !== undefined) {
        tx.set(this.#runRef(outcome.run.runId), outcome.run);
      }
      for (const additionalRun of outcome.additionalRuns ?? []) {
        tx.set(this.#runRef(additionalRun.runId), additionalRun);
      }
      this.#commitProviderCooldownWrites(tx, cooldownWrites);
      for (const entry of [...outcome.outbox, ...written.events]) {
        tx.set(this.#outboxRef(entry.entryId), entry);
      }
      return outcome;
    });
  }

  async beginGithubAnchorProjectionRefresh(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<number> {
    const ref = this.#githubAnchorRef(anchor);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const generation =
        typeof snapshot.data()?.['refreshGeneration'] === 'number'
          ? snapshot.data()?.['refreshGeneration'] + 1
          : 1;
      tx.set(ref, { refreshGeneration: generation }, { merge: true });
      return generation;
    });
  }

  async applyGithubAnchorProjectionRefresh(input: {
    anchor: GithubAnchorProjection['anchor'];
    generation: number;
    projection?: GithubAnchorProjection;
  }): Promise<boolean> {
    const ref = this.#githubAnchorRef(input.anchor);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.data()?.['refreshGeneration'] !== input.generation) {
        return false;
      }
      if (input.projection === undefined) {
        // Keep a bounded change-feed watermark even when the source disappears.
        // Deleting the projection must notify open dashboards too.
        tx.set(ref, {
          refreshGeneration: input.generation,
          streamChangedAt: FieldValue.serverTimestamp(),
        });
        return true;
      }
      const next = githubAnchorProjectionSchema.parse(input.projection);
      if (taskKey(next.anchor) !== taskKey(input.anchor)) {
        throw new Error(
          'GitHub anchor refresh projection does not match its fence',
        );
      }
      // The refresh fence was created above, so this is always an update of
      // an existing document. `update` both replaces the projection map
      // exactly (rather than retaining removed optional fields) and is the
      // Firestore write form that permits the top-level delete sentinel used
      // to remove this anchor from the open-order index.
      tx.update(ref, {
        projection: next,
        streamChangedAt: FieldValue.serverTimestamp(),
        refreshGeneration: input.generation,
        ...(next.state === 'open'
          ? { openUpdatedAt: next.sourceUpdatedAt }
          : { openUpdatedAt: FieldValue.delete() }),
      });
      return true;
    });
  }

  async readGithubAnchorProjection(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<GithubAnchorProjection | undefined> {
    const snapshot = await this.#githubAnchorRef(anchor).get();
    const projection = snapshot.data()?.['projection'];
    return projection === undefined
      ? undefined
      : githubAnchorProjectionSchema.parse(projection);
  }

  async readGithubAnchorMergeEvidence(
    anchors: readonly GithubAnchorProjection['anchor'][],
  ): Promise<(GithubAnchorMergeEvidence | undefined)[]> {
    const fieldMask = GITHUB_ANCHOR_MERGE_EVIDENCE_FIELDS.map(
      (field) => `projection.${field}`,
    );
    const chunks: GithubAnchorProjection['anchor'][][] = [];
    for (
      let offset = 0;
      offset < anchors.length;
      offset += FirestoreStore.#getAllSize
    )
      chunks.push(anchors.slice(offset, offset + FirestoreStore.#getAllSize));
    const got = await Promise.all(
      chunks.map((chunk) =>
        chunk.length === 0
          ? []
          : this.#firestore.getAll(
              ...chunk.map((anchor) => this.#githubAnchorRef(anchor)),
              { fieldMask },
            ),
      ),
    );
    return got.flat().map((snapshot) => {
      const evidence = snapshot.data()?.['projection'];
      return evidence === undefined
        ? undefined
        : githubAnchorMergeEvidenceSchema.parse(evidence);
    });
  }

  async readGithubAnchorProjections(
    anchors: readonly GithubAnchorProjection['anchor'][],
  ): Promise<(GithubAnchorProjection | undefined)[]> {
    const chunks: GithubAnchorProjection['anchor'][][] = [];
    for (
      let offset = 0;
      offset < anchors.length;
      offset += FirestoreStore.#getAllSize
    )
      chunks.push(anchors.slice(offset, offset + FirestoreStore.#getAllSize));
    const got = await Promise.all(
      chunks.map((chunk) =>
        chunk.length === 0
          ? []
          : this.#firestore.getAll(
              ...chunk.map((anchor) => this.#githubAnchorRef(anchor)),
            ),
      ),
    );
    return got.flat().map((snapshot) => {
      const projection = snapshot.data()?.['projection'];
      return projection === undefined
        ? undefined
        : githubAnchorProjectionSchema.parse(projection);
    });
  }

  async listOpenGithubAnchorProjections(
    limit = 200,
  ): Promise<GithubAnchorProjection[]> {
    return (await this.listOpenGithubAnchorProjectionPage({ limit }))
      .projections;
  }

  async listGithubAnchorsMergedSince(
    since: string,
  ): Promise<GithubAnchorProjection['anchor'][]> {
    // A range on one field is served by its automatic single-field index;
    // the projection returns only each anchor, not the whole PR snapshot.
    const snapshot = await this.#githubAnchors
      .where('projection.mergedAt', '>=', since)
      .select('projection.anchor')
      .get();
    return snapshot.docs.map((doc) =>
      githubAnchorSchema.parse(doc.get('projection.anchor')),
    );
  }

  async listOpenGithubAnchorProjectionPage(input: {
    limit: number;
    cursor?: OpenGithubAnchorProjectionCursor;
  }): Promise<OpenGithubAnchorProjectionPage> {
    // `openUpdatedAt` is present only on open anchors. Ordering this single
    // field plus document id gives this cursor a stable total order without
    // an application-maintained composite index. Each datastore read remains
    // bounded; callers follow nextCursor until selection is complete.
    let query = this.#githubAnchors
      .orderBy('openUpdatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(input.limit);
    if (input.cursor !== undefined) {
      query = query.startAfter(
        input.cursor.sourceUpdatedAt,
        encodeURIComponent(taskKey(input.cursor.anchor)),
      );
    }
    const snapshot = await query.get();
    const entries = snapshot.docs.map((doc) => ({
      projection: githubAnchorProjectionSchema.parse(doc.data()['projection']),
    }));
    const last = entries.at(-1)?.projection;
    return {
      projections: entries.flatMap(({ projection }) => {
        // A pre-fence document may retain its old index field. Never present a
        // closed snapshot as an open queue item while the backfill refreshes it.
        return projection.state === 'open' ? [projection] : [];
      }),
      ...(last !== undefined && snapshot.size === input.limit
        ? {
            nextCursor: {
              sourceUpdatedAt: last.sourceUpdatedAt,
              anchor: last.anchor,
            },
          }
        : {}),
    };
  }

  async claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
    excludeEntryIds?: ReadonlySet<string>;
  }): Promise<LeasedOutboxEntry[]> {
    if (input.limit <= 0) return [];

    return this.#firestore.runTransaction(async (tx) => {
      // Keep this index-free: both queries are single-field equality queries.
      // The leased population is bounded by active drains and the short
      // lease, so reading it to filter expiry client-side stays small.
      // Crucially, the query and every claim write share one transaction:
      // concurrent drains cannot both return ownership of the same document.
      const leasedSnapshot = await tx.get(
        this.#outbox.where('state', '==', 'leased'),
      );
      // No server-side `.limit()` on the pending query (#1548): the pending
      // population is exactly the backlog this store exists to drain, so
      // truncating it server-side before `excludeEntryIds` is applied would
      // silently favor whatever arbitrary subset Firestore's unordered
      // index scan happens to return first -- which is precisely how one
      // persistently-failing entry starved 145 of 162 pending entries for
      // six days without ever giving them a single claim attempt. Reading
      // the whole equality-filtered set and slicing client-side, after the
      // exclusion filter, is the same trade `listQueuedRuns` already makes
      // for the same reason (composite-index-free, and this population is
      // expected to stay small in steady state -- large only during exactly
      // the incident this fix targets, which drains it back down).
      const pendingSnapshot = await tx.get(
        this.#outbox.where('state', '==', 'pending'),
      );
      const cutoff = Date.parse(input.now);
      const expired = leasedSnapshot.docs
        .map((doc) => ({
          ref: doc.ref,
          entry: outboxEntrySchema.parse(doc.data()),
        }))
        .filter(
          ({ entry }) =>
            entry.state === 'leased' &&
            Date.parse(entry.leaseExpiresAt) <= cutoff,
        );
      const excluded = input.excludeEntryIds;
      // #1548 follow-up: a pending entry still backing off from its last
      // delivery failure (`nextAttemptAt` in the future) is skipped here,
      // the same as an explicitly excluded one -- it never affects expired-
      // lease recovery above, since a lease can only be outstanding on an
      // entry that was itself already eligible to be claimed. See
      // `OrchestratorStore.claimPendingOutbox`'s doc comment. Sorted by
      // `byOutboxClaimFairness` (starvation fix) so a never-attempted entry
      // is never stuck behind an arbitrarily larger due-again,
      // already-failing set -- see that function's doc comment.
      const pendingCandidates = pendingSnapshot.docs
        .map((doc) => ({
          ref: doc.ref,
          entry: outboxEntrySchema.parse(doc.data()),
        }))
        .filter(
          ({ entry }) =>
            !(excluded?.has(entry.entryId) ?? false) &&
            (entry.nextAttemptAt === undefined ||
              Date.parse(entry.nextAttemptAt) <= cutoff),
        )
        .sort((a, b) => byOutboxClaimFairness(a.entry, b.entry));
      const eligible = [...expired, ...pendingCandidates].slice(0, input.limit);

      return eligible.map(({ ref, entry }): LeasedOutboxEntry => {
        const { state: _state, ...rest } = entry;
        const claimed: LeasedOutboxEntry = {
          ...rest,
          state: 'leased',
          claimId: crypto.randomUUID(),
          leaseExpiresAt: input.leaseExpiresAt,
          attempts: entry.attempts + 1,
          updatedAt: input.now,
        };
        tx.set(ref, claimed);
        return claimed;
      });
    });
  }

  async settleOutbox(input: OutboxSettlement): Promise<boolean> {
    const ref = this.#outboxRef(input.entryId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false; // no-op, matching MemoryStore
      const settled = settleOutboxEntry(
        outboxEntrySchema.parse(snapshot.data()),
        input,
      );
      if (settled === undefined) return false;
      tx.set(ref, settled);
      return true;
    });
  }

  async wakeOutbox(input: { entryId: string; now: string }): Promise<boolean> {
    const ref = this.#outboxRef(input.entryId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const woken = wakeOutboxEntry(
        outboxEntrySchema.parse(snapshot.data()),
        input.now,
      );
      if (woken === undefined) return false;
      tx.set(ref, woken);
      return true;
    });
  }

  /** Equality-only filters on the binding, so no composite index is needed. */
  async readWaitingDeliveryTasks(binding: {
    repo: string;
    number?: number;
  }): Promise<VersionedTask[]> {
    let query = this.#tasks
      .where('task.delivery.state', '==', 'waiting')
      .where('task.delivery.repo', '==', binding.repo);
    if (binding.number !== undefined) {
      query = query.where('task.delivery.number', '==', binding.number);
    }
    const snapshot = await query
      .limit(binding.number === undefined ? 50 : 10)
      .get();
    return snapshot.docs.map((doc) => taskDocSchema.parse(doc.data()));
  }

  async readSourceWorkId(sourceKey: string): Promise<string | undefined> {
    const snapshot = await this.#sourceWorkIds
      .doc(encodeURIComponent(sourceKey))
      .get();
    return snapshot.exists
      ? z.object({ workId: z.string() }).parse(snapshot.data()).workId
      : undefined;
  }

  async readTrackerIssue(
    reference: IssueReference,
  ): Promise<TrackerIssueProjection | undefined> {
    const snapshot = await this.#trackerIssues
      .doc(encodeURIComponent(issueSourceKey(reference)))
      .get();
    return snapshot.exists
      ? trackerIssueProjectionSchema.parse(snapshot.data())
      : undefined;
  }

  async writeTrackerIssue(input: TrackerIssueProjection): Promise<void> {
    const projection = trackerIssueProjectionSchema.parse(input);
    const ref = this.#trackerIssues.doc(
      encodeURIComponent(issueSourceKey(projection.issue.reference)),
    );
    await this.#firestore.runTransaction(async (tx) => {
      const previous = await tx.get(ref);
      if (
        previous.exists &&
        Date.parse(
          trackerIssueProjectionSchema.parse(previous.data()).issue.updatedAt,
        ) >= Date.parse(projection.issue.updatedAt)
      )
        return;
      tx.set(ref, projection);
    });
  }

  async listTrackerIssues(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ issues: TrackerIssueProjection[]; nextCursor?: string }> {
    const query = this.#trackerIssues.orderBy(FieldPath.documentId());
    const page = await (
      input.cursor === undefined
        ? query
        : query.startAfter(encodeURIComponent(input.cursor))
    )
      .limit(input.limit + 1)
      .get();
    const docs = page.docs.slice(0, input.limit);
    return {
      issues: docs.map((doc) => trackerIssueProjectionSchema.parse(doc.data())),
      ...(page.docs.length > input.limit
        ? { nextCursor: decodeURIComponent(docs[docs.length - 1].id) }
        : {}),
    };
  }

  async resolveSourceWorkId(
    sourceKey: string,
    candidateWorkId: string,
  ): Promise<string> {
    const ref = this.#sourceWorkIds.doc(encodeURIComponent(sourceKey));
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists)
        return z.object({ workId: z.string() }).parse(snapshot.data()).workId;
      tx.create(ref, { workId: candidateWorkId });
      return candidateWorkId;
    });
  }

  async listNativeTasks(
    limit?: number,
    before?: string,
  ): Promise<VersionedTask[]> {
    // The `orderBy` IS the filter. Firestore excludes any document that
    // lacks the ordered field entirely, and a GitHub-anchored task
    // document stores `task.task.repo`/`task.task.issue` with no
    // `workId` -- so ordering by `task.task.workId` returns exactly the
    // native anchors. Served by the automatic single-field index: no
    // composite index, and (crucially) no new persisted discriminator
    // field, which would have meant rewriting every existing task
    // document before this query could be trusted.
    //
    // `desc`: `workId` is a ULID, so lexicographic order on it is creation
    // order -- descending puts the newest task first, still served by that
    // same automatic single-field index (Firestore indexes both
    // directions), and `limit` bounds the read itself rather than reading
    // every native task ever created just to slice it down after.
    let query = this.#tasks.orderBy('task.task.workId', 'desc');
    // `startAfter` on a single orderBy'd field takes the field's value
    // directly (no document snapshot needed) and returns strictly older
    // entries than it in this same order -- exactly "the page after the
    // one that ended in `before`".
    if (before !== undefined) query = query.startAfter(before);
    const snapshot = await query.limit(limit ?? 200).get();
    return snapshot.docs.map((doc) => taskDocSchema.parse(doc.data()));
  }

  async listTasks(
    limit?: number,
    before?: TaskListCursor,
  ): Promise<VersionedTask[]> {
    // `updatedAt` makes this a useful live-console order rather than a
    // creation-order archive. Firestore's document id is the stable
    // tiebreaker, so concurrent decisions at the same timestamp page
    // without drops or repeats. `__name__` is the implicit final component
    // of Firestore's single-field index for an ordered field, so this does
    // not require an operator-managed composite index or a data migration.
    let query = this.#tasks
      .orderBy('task.updatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    if (before !== undefined) {
      query = query.startAfter(
        before.updatedAt,
        encodeURIComponent(before.taskKey),
      );
    }
    const snapshot = await query.limit(limit ?? 200).get();
    return snapshot.docs.map((doc) => taskDocSchema.parse(doc.data()));
  }

  async listTasksBySortKey(
    key: TaskSortKey,
    limit?: number,
    before?: TaskListCursor,
  ): Promise<VersionedTask[]> {
    // Ordering by the key skips every task without it, and `__name__` is the
    // implicit final component of the key's automatic single-field index (as
    // in `listTasks`), so this needs no composite index.
    let query = this.#tasks
      .orderBy(`derived.${key}`, 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    if (before !== undefined) {
      query = query.startAfter(
        before.updatedAt,
        encodeURIComponent(before.taskKey),
      );
    }
    const snapshot = await query.limit(limit ?? 200).get();
    return snapshot.docs.map((doc) => taskDocSchema.parse(doc.data()));
  }

  async listExpiredRuns(now: string): Promise<Run[]> {
    const cutoff = Date.parse(now);
    // A single query for `state in [...] AND leaseExpiresAt <= now` would
    // combine an equality/`in` filter with a range filter on a *different*
    // field, which Firestore only serves with a composite index. Rather
    // than require one, reuse the per-live-state equality queries
    // `listLiveRuns` already runs (each covered by Firestore's automatic
    // single-field index) and apply the lease-expiry filter client-side.
    return (await this.listLiveRuns()).filter((run) => {
      const deadline = runRecoveryDeadline(run);
      return deadline !== undefined && Date.parse(deadline) <= cutoff;
    });
  }

  async listLiveRuns(): Promise<Run[]> {
    // One single-field equality query per live state, merged -- see
    // `listExpiredRuns` above for why this shape rather than an `in` query
    // combined with a range filter.
    const perState = await Promise.all(
      LIVE_STATES.map((state) => this.#runs.where('state', '==', state).get()),
    );
    return perState.flatMap((snapshot) =>
      snapshot.docs.map((doc) => runSchema.parse(doc.data())),
    );
  }

  async listRecentRuns(limit: number, before?: RunListCursor): Promise<Run[]> {
    // A global updatedAt order needs only Firestore's automatic single-field
    // index. Do not add a state filter here: filtering another field before
    // ordering would require a composite index and turn this bounded console
    // read into deployment configuration. The document-id tiebreak matches
    // the index's implicit `__name__` order, so it needs no index either.
    const ordered = this.#runs
      .orderBy('updatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    const snapshot = await (
      before === undefined
        ? ordered
        : ordered.startAfter(before.updatedAt, encodeURIComponent(before.runId))
    )
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => runSchema.parse(doc.data()));
  }

  async readQueueAdmissionStatus(input: {
    pipelines: readonly string[];
    now: string;
  }) {
    const pipelines = [...new Set(input.pipelines)];
    return this.#firestore.runTransaction(
      async (tx) => {
        const [liveRunDocs, cooldownSnapshots, windowSnapshots] =
          await Promise.all([
            Promise.all(
              LIVE_STATES.map((state) =>
                readAllPages(
                  this.#runs.where('state', '==', state),
                  this.#readPageSize,
                  (page) => tx.get(page),
                ),
              ),
            ),
            Promise.all(
              pipelines.map((pipeline) =>
                tx.get(
                  this.#providerCooldowns.doc(encodeURIComponent(pipeline)),
                ),
              ),
            ),
            Promise.all(
              pipelines.map((pipeline) =>
                tx.get(
                  this.#credentialWindows.doc(encodeURIComponent(pipeline)),
                ),
              ),
            ),
          ]);
        const cooldowns = new Map();
        for (const [index, pipeline] of pipelines.entries()) {
          const cooldown = parseProviderCooldown(
            cooldownSnapshots[index]?.data(),
            pipeline,
          );
          if (cooldown !== undefined) cooldowns.set(pipeline, cooldown);
        }
        return projectQueueAdmissionStatus(
          liveRunDocs.flatMap((docs) =>
            docs.map((doc) => runSchema.parse(doc.data())),
          ),
          cooldowns,
          pipelines,
          input.now,
          Object.fromEntries(
            pipelines.map((pipeline, index) => [
              pipeline,
              windowSnapshots[index]?.data(),
            ]),
          ),
        );
      },
      { readOnly: true },
    );
  }

  async enqueueRun(input: { runId: string; now: string }): Promise<void> {
    const ref = this.#runRef(input.runId);
    await this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const run = runSchema.parse(snapshot.data());
      if (run.queue !== undefined) return;
      tx.set(ref, {
        ...run,
        queue: { state: 'queued' },
        updatedAt: input.now,
      });
    });
  }

  async listCredentialOperations(input: {
    now: string;
    limit: number;
  }): Promise<Run[]> {
    const snapshot = await this.#runs
      .where('credentialOperation.recoverAfter', '<=', input.now)
      .orderBy('credentialOperation.recoverAfter')
      .limit(input.limit)
      .get();
    return snapshot.docs.map((doc) => runSchema.parse(doc.data()));
  }

  async claimQueuedRun(input: {
    pipelines: readonly string[];
    now: string;
    claimedBy: string;
    claimedBySubject: string;
    tokenHash: string;
    placementAware?: boolean;
  }): Promise<Run | undefined> {
    return this.#firestore.runTransaction(async (tx) => {
      // One query per candidate pipeline for queued work and each live state.
      // Every query uses two equality clauses, so provider-aware occupancy
      // remains index-compatible with the former single-pipeline claim shape.
      // Reading selection and occupancy in this transaction makes a racing
      // claimant retry after the winner changes either value.
      const requested = [...new Set(input.pipelines)];
      // Queued candidates first: most claims are idle polls, and with nothing
      // queued there is nothing to order or place, so the cooldown,
      // occupancy, priority and credential reads below are skipped and an
      // idle poll is one round trip. Only live runs are candidates; a run
      // canceled while queued can keep `queue.state: queued`.
      const queuedByPipeline = await Promise.all(
        requested.map((pipeline) =>
          tx.get(
            this.#runs
              .where('queue.state', '==', 'queued')
              .where('pipeline', '==', pipeline)
              .where('state', 'in', LIVE_STATES),
          ),
        ),
      );
      if (queuedByPipeline.every((snapshot) => snapshot.empty))
        return undefined;
      const cooldowns = await Promise.all(
        requested.map((pipeline) =>
          tx.get(this.#providerCooldowns.doc(encodeURIComponent(pipeline))),
        ),
      );
      const grantedIndexes = requested.flatMap((_, index) =>
        providerIsCoolingDown(cooldowns[index]?.data(), input.now)
          ? []
          : [index],
      );
      const granted = grantedIndexes.map((index) => requested[index]!);
      const queuedSnapshots = grantedIndexes.map(
        (index) => queuedByPipeline[index]!,
      );
      if (queuedSnapshots.every((snapshot) => snapshot.empty)) return undefined;
      const [prioritySnapshots, windowSnapshots] = await Promise.all([
        Promise.all(
          granted.map((pipeline) =>
            tx.get(this.#priorityPositions.doc(encodeURIComponent(pipeline))),
          ),
        ),
        Promise.all(
          granted.map((pipeline) =>
            tx.get(this.#credentialWindows.doc(encodeURIComponent(pipeline))),
          ),
        ),
      ]);
      const priorityPositions = new Map(
        granted.map((pipeline, index) => [
          pipeline,
          prioritySnapshots[index]?.exists
            ? queuePriorityCursorSchema.parse(prioritySnapshots[index].data())
                .position
            : 0,
        ]),
      );
      const liveSnapshots = await Promise.all(
        LIVE_STATES.map((state) =>
          Promise.all(
            granted.map((pipeline) =>
              tx.get(
                this.#runs
                  .where('state', '==', state)
                  .where('pipeline', '==', pipeline),
              ),
            ),
          ),
        ),
      );
      const queued = queuedSnapshots
        .flatMap((snapshot) => snapshot.docs)
        .map((doc) => ({ doc, run: runSchema.parse(doc.data()) }));
      const live = liveSnapshots
        .flatMap((snapshots) => snapshots)
        .flatMap((snapshot) => snapshot.docs)
        .map((doc) => runSchema.parse(doc.data()));
      const selected = selectFairQueuedRun(
        queued.map(({ run }) => run),
        live,
        granted,
        input.now,
        priorityPositions,
        Object.fromEntries(
          granted.map((pipeline, index) => [
            pipeline,
            windowSnapshots[index]?.data(),
          ]),
        ),
      );
      const first = queued.find(({ run }) => run.runId === selected?.runId);
      if (first === undefined) return undefined;
      const claimed = claimQueuedRun(first.run, input);
      tx.set(first.doc.ref, claimed);
      tx.set(
        this.#priorityPositions.doc(encodeURIComponent(claimed.pipeline)),
        {
          position: queuePriorityTurnAfter(
            priorityPositions.get(claimed.pipeline) ?? 0,
            claimed.priority ?? 'normal',
          ),
        },
      );
      return claimed;
    });
  }

  async refreshTaskDerived(id: TaskId): Promise<boolean> {
    const taskRef = this.#taskRef(id);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(taskRef);
      if (!snapshot.exists) return false;
      const { task } = taskDocSchema.parse(snapshot.data());
      const runs = await this.#taskRunsIn(tx, id);
      if (runs === undefined) return false;
      tx.update(taskRef, { derived: taskDerivedFrom(task, runs) });
      return true;
    });
  }

  async listRunRefsWithSummary(summary: string): Promise<RunRef[]> {
    // Equality on one field: the automatic single-field index serves it.
    // Projected to two fields: for 250 runs this reads 0.16 MB instead of
    // 2.4 MB of event history (production, 2026-11-25).
    const snapshot = await this.#runs
      .where('result.summary', '==', summary)
      .select('task', 'updatedAt')
      .get();
    return snapshot.docs.map((doc) =>
      runRefSchema.parse({
        task: doc.get('task'),
        updatedAt: doc.get('updatedAt'),
      }),
    );
  }

  async listQueuedRuns(limit?: number): Promise<Run[]> {
    // Combining the `queue.state` equality filter with `orderBy('createdAt')`
    // (a different field) would need a composite index -- see
    // `listExpiredRuns`/`claimPendingOutbox` above for the same trade-off
    // elsewhere in this file. Instead, read every queued run through the
    // automatic single-field index and sort/bound client-side; the queued
    // population is expected to stay small by design (the queue exists for
    // fast pickup, not as a backlog), so reading it in full before slicing
    // is the same trade `claimPendingOutbox` already makes for its pending
    // population.
    // Live states only: a run canceled while queued can keep
    // `queue.state: queued`, and hundreds of those accumulated.
    const snapshot = await this.#runs
      .where('queue.state', '==', 'queued')
      .where('state', 'in', LIVE_STATES)
      .get();
    return snapshot.docs
      .map((doc) => runSchema.parse(doc.data()))
      .filter((run) => isLive(run.state))
      .sort((a, b) => queueOrderAt(a).localeCompare(queueOrderAt(b)))
      .slice(0, limit);
  }
  async readCredentialWindow(
    pipeline: string,
  ): Promise<ProviderCredentialWindow | undefined> {
    return parseCredentialWindow(
      (
        await this.#credentialWindows.doc(encodeURIComponent(pipeline)).get()
      ).data(),
      pipeline,
    );
  }

  async recordCredentialWindow(
    window: ProviderCredentialWindow,
  ): Promise<void> {
    const ref = this.#credentialWindows.doc(
      encodeURIComponent(window.pipeline),
    );
    await this.#firestore.runTransaction(async (tx) => {
      const current = parseCredentialWindow(
        (await tx.get(ref)).data(),
        window.pipeline,
      );
      if (
        current !== undefined &&
        (current.observedAt >= window.observedAt ||
          current.refreshDueAt === window.refreshDueAt)
      )
        return;
      tx.set(ref, window);
    });
  }

  async readProviderCooldowns(
    pipelines: readonly string[],
  ): Promise<Readonly<Record<string, unknown>>> {
    const records = await Promise.all(
      pipelines.map((pipeline) =>
        this.#providerCooldowns.doc(encodeURIComponent(pipeline)).get(),
      ),
    );
    return Object.fromEntries(
      pipelines.map((pipeline, index) => [pipeline, records[index]?.data()]),
    );
  }

  async releaseQueuedRunClaim(input: {
    runId: string;
    claimedBy: string;
    tokenHash: string;
    now: string;
    deferredUntil?: string;
  }): Promise<boolean> {
    const ref = this.#runRef(input.runId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const run = runSchema.parse(snapshot.data());
      if (
        !isLive(run.state) ||
        run.credentialOperation !== undefined ||
        !isClaimant(run, input.tokenHash) ||
        run.queue?.claimedBy !== input.claimedBy
      ) {
        return false;
      }
      tx.set(ref, {
        ...run,
        queue: {
          state: 'queued',
          ...(input.deferredUntil === undefined
            ? {}
            : { deferredUntil: input.deferredUntil }),
        },
        updatedAt: input.now,
      });
      return true;
    });
  }

  #taskRef(id: TaskId): DocumentReference {
    return this.#tasks.doc(encodeURIComponent(taskKey(id)));
  }

  /** Equality-only query shape, shared by the public history read and the
   * request transaction so durable idempotency never needs a new index. */
  /** Every run of a task, read inside `tx` so the stored item state is
   * derived from the same snapshot the transaction writes over. Undefined
   * when any of them does not parse: the task is then written without a
   * stored state (readers derive it) rather than one derived from part of
   * its runs, and an unrelated malformed run cannot fail the transaction. */
  async #taskRunsIn(tx: Transaction, id: TaskId): Promise<Run[] | undefined> {
    const snapshot = await tx.get(this.#runsForTask(id));
    const runs: Run[] = [];
    for (const doc of snapshot.docs) {
      const parsed = runSchema.safeParse(doc.data());
      if (!parsed.success) return undefined;
      runs.push(parsed.data);
    }
    return runs;
  }

  #runsForTask(id: TaskId) {
    return isWorkAnchor(id)
      ? this.#runs.where('task.workId', '==', id.workId)
      : this.#runs
          .where('task.repo', '==', id.repo)
          .where('task.issue', '==', id.issue);
  }

  /** A constant-size exact idempotency lookup. Every current Run persists its
   * request source, so caller and automatic-retry histories remain separate
   * without a legacy broad query. Equality-only filters keep this on
   * Firestore's automatic index merging path. */
  #runsForRequest(id: TaskId, requestId: string, source: RequestSource) {
    return this.#runsForTask(id)
      .where('requestId', '==', requestId)
      .where('requestSource', '==', source)
      .limit(1);
  }

  #runRef(runId: string): DocumentReference {
    return this.#runs.doc(encodeURIComponent(runId));
  }

  /** `runs/{runId}/message-chunks/{sha256}.{index}`: beside the run it
   * belongs to, never read by run listings or queries. */
  #runMessageChunkRef(
    runId: string,
    overflow: RunMessageOverflow,
    index: number,
  ): DocumentReference {
    return this.#runRef(runId)
      .collection('message-chunks')
      .doc(`${overflow.sha256}.${index}`);
  }

  /** One document per claim beside the run, like its message chunks. The
   * claim's fingerprint is the SHA-256 of its token, as the run stores it. */
  #runEvidenceRef(runId: string, claimFingerprint: string): DocumentReference {
    return this.#runRef(runId).collection('evidence').doc(claimFingerprint);
  }

  #outboxRef(entryId: string): DocumentReference {
    return this.#outbox.doc(encodeURIComponent(entryId));
  }

  #requestBindingRef(id: TaskId, bindingKey: string): DocumentReference {
    return this.#requestBindings.doc(
      encodeURIComponent(JSON.stringify([taskKey(id), bindingKey])),
    );
  }

  #githubAnchorRef(
    anchor: GithubAnchorProjection['anchor'],
  ): DocumentReference {
    return this.#githubAnchors.doc(encodeURIComponent(taskKey(anchor)));
  }
}
