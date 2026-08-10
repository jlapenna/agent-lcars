import {
  type DispatchLedger,
  formatAttemptId,
  LEDGER_ACTIVE_GENERATION_STATES,
  type LedgerAuthorization,
  type LedgerGeneration,
  type LedgerGenerationState,
  type LedgerSource,
} from '@agent-lcars/dispatch-contracts';

import {
  type AttemptRecord,
  type AuthorizationRecord,
  type IntentRecord,
  type IntentState,
  type SignalRecord,
  type StoragePort,
  type StoredTask,
  type StoredTaskInput,
  type TaskLease,
  type TaskRef,
  TaskWriteConflictError,
} from './port';

export const DEFAULT_TASK_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_CAS_ATTEMPTS = 8;

function mapState(state: LedgerGenerationState): IntentState {
  if (state === 'completed') return 'completed';
  if (
    ['dispatch-rejected', 'superseded', 'superseded-by-close'].includes(state)
  )
    return 'superseded';
  if (
    ['active', 'completion-observed', 'completion-awaiting-terminal'].includes(
      state,
    )
  )
    return 'active';
  if (['dispatching', 'dispatch-unknown'].includes(state)) return 'dispatching';
  if (state === 'accepted' || state === 'pending') return state;
  throw new Error(`Unhandled ledger generation state: ${state}`);
}
function mapAuthorization(
  value: LedgerAuthorization | undefined,
): AuthorizationRecord {
  if (!value) return { observed: true };
  return 'authorized' in value
    ? { authorized: value.authorized, actor: value.actor, rule: value.rule }
    : { observed: true, actor: value.actor, workflow: value.workflow };
}
function mapIntent(generation: LedgerGeneration): IntentRecord {
  const attempt = generation.attempt;
  const mapped: AttemptRecord | undefined = attempt
    ? {
        attemptId:
          attempt.attemptId ??
          formatAttemptId({
            generation: generation.generation,
            intentId: generation.intentId,
          }),
        token: attempt.token ?? '',
        dispatchStartedAt: attempt.dispatchStartedAt ?? generation.occurredAt,
        runId: attempt.runId,
        runUrl: attempt.runUrl,
        htmlUrl: attempt.htmlUrl,
        boundAt: attempt.boundAt,
        completedAt: attempt.completedAt,
        conclusion: attempt.conclusion,
        outcome: attempt.outcome,
        outcomeReference: attempt.outcomeReference,
      }
    : undefined;
  return {
    intentId: generation.intentId,
    sourceId: generation.sourceId,
    occurredAt: generation.occurredAt,
    state: mapState(generation.state),
    attempt: mapped,
  };
}
function projectLedgerToStoredTask(ledger: DispatchLedger): StoredTaskInput {
  const desiredIntentId =
    ledger.generations.find((g) => LEDGER_ACTIVE_GENERATION_STATES.has(g.state))
      ?.intentId ??
    ledger.generations.find((g) => g.state === 'pending')?.intentId ??
    ledger.generations.find((g) => g.state === 'accepted')?.intentId;
  return {
    desiredIntentId,
    signals: ledger.sources.map((source: LedgerSource): SignalRecord => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      occurredAt: source.occurredAt,
      authorization: mapAuthorization(source.authorization),
    })),
    intents: ledger.generations.map(mapIntent),
    controllerState: structuredClone(ledger),
  };
}

export class TaskLeaseBusyError extends Error {
  constructor(
    public readonly task: TaskRef,
    public readonly lease: TaskLease,
  ) {
    super(
      `Task ${task.repository}#${task.issue} is already leased by ${lease.owner} until ${lease.expiresAt}`,
    );
    this.name = 'TaskLeaseBusyError';
  }
}

export class AuthorityStateNotFoundError extends Error {
  constructor(public readonly task: TaskRef) {
    super(
      `No authoritative controller state exists for ${task.repository}#${task.issue}`,
    );
    this.name = 'AuthorityStateNotFoundError';
  }
}

export class AuthorityStateMissingError extends Error {
  constructor(
    public readonly task: TaskRef,
    /** True only when the compatibility projection proves no intent remains
     * accepted, pending, dispatching, or active. Callers may use this narrow
     * fact to quarantine a retired task; absence of a compatibility record
     * and any live-looking projection remain fail-closed. */
    public readonly compatibilityQuiescent = false,
  ) {
    super(
      `Task ${task.repository}#${task.issue} has existing compatibility state but no exact authoritative controller state; recover the missing controller state before retrying`,
    );
    this.name = 'AuthorityStateMissingError';
  }
}

export interface AuthoritySession {
  port: StoragePort;
  owner: string;
  revision: number;
  lease: TaskLease;
}

export interface AuthorityState {
  ledger: DispatchLedger;
  session: AuthoritySession;
}

function leaseIsLive(lease: TaskLease | undefined, now: string): boolean {
  return Boolean(lease && Date.parse(lease.expiresAt) > Date.parse(now));
}

/** Acquire the shared Action/hosted-controller serialization boundary. */
export async function acquireAuthority(
  port: StoragePort,
  task: TaskRef,
  owner: string,
  seed: DispatchLedger,
  options: {
    now?: () => string;
    leaseMs?: number;
    maxAttempts?: number;
    createIfMissing?: boolean;
    busyWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AuthorityState> {
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = options.leaseMs ?? DEFAULT_TASK_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_CAS_ATTEMPTS;
  const createIfMissing = options.createIfMissing ?? true;
  const busyWaitMs = options.busyWaitMs ?? 0;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const busyDeadline = Date.now() + busyWaitMs;
  let lastConflict: TaskWriteConflictError | undefined;

  let conflicts = 0;
  while (conflicts < maxAttempts) {
    const observedAt = now();
    const current = await port.readTask(task);
    if (!current && !createIfMissing) {
      throw new AuthorityStateNotFoundError(task);
    }
    if (current && !current.controllerState) {
      const compatibilityQuiescent =
        current.desiredIntentId === undefined &&
        current.intents.every((intent) =>
          ['completed', 'superseded'].includes(intent.state),
        );
      throw new AuthorityStateMissingError(task, compatibilityQuiescent);
    }
    if (
      current?.lease &&
      current.lease.owner !== owner &&
      leaseIsLive(current.lease, observedAt)
    ) {
      const remainingBudget = busyDeadline - Date.now();
      if (remainingBudget <= 0) {
        throw new TaskLeaseBusyError(task, current.lease);
      }
      const remainingLease =
        Date.parse(current.lease.expiresAt) - Date.parse(observedAt);
      await sleep(
        Math.max(1, Math.min(1_000, remainingBudget, remainingLease)),
      );
      continue;
    }
    const ledger = structuredClone(current?.controllerState ?? seed);
    const lease: TaskLease = {
      owner,
      acquiredAt:
        current?.lease?.owner === owner ? current.lease.acquiredAt : observedAt,
      expiresAt: new Date(Date.parse(observedAt) + leaseMs).toISOString(),
    };
    try {
      const stored = await port.writeTask(
        task,
        current?.revision,
        { ...projectLedgerToStoredTask(ledger), lease },
        observedAt,
      );
      return {
        ledger,
        session: { port, owner, revision: stored.revision, lease },
      };
    } catch (error) {
      if (!(error instanceof TaskWriteConflictError)) throw error;
      lastConflict = error;
      conflicts += 1;
    }
  }
  throw lastConflict;
}

/** Persist one controller checkpoint while retaining the caller's lease. */
export async function persistAuthority(
  session: AuthoritySession,
  ledger: DispatchLedger,
  now: string = new Date().toISOString(),
): Promise<StoredTask> {
  session.lease = {
    ...session.lease,
    expiresAt: new Date(Date.parse(now) + DEFAULT_TASK_LEASE_MS).toISOString(),
  };
  const written = await session.port.writeTask(
    ledger.task,
    session.revision,
    { ...projectLedgerToStoredTask(ledger), lease: session.lease },
    now,
  );
  session.revision = written.revision;
  return written;
}

/** Release only the lease this session acquired, preserving final state. */
export async function releaseAuthority(
  session: AuthoritySession,
  ledger: DispatchLedger,
  now: string = new Date().toISOString(),
): Promise<void> {
  const written = await session.port.writeTask(
    ledger.task,
    session.revision,
    projectLedgerToStoredTask(ledger),
    now,
  );
  session.revision = written.revision;
}
