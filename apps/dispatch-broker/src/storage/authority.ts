import type { DispatchLedger } from '@agent-lcars/dispatch-contracts';

import {
  type StoragePort,
  type StoredTask,
  type TaskLease,
  type TaskRef,
  TaskWriteConflictError,
} from './port.js';
import { projectLedgerToStoredTask } from './shadow.js';

export const DEFAULT_TASK_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_CAS_ATTEMPTS = 8;

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
  } = {},
): Promise<AuthorityState> {
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = options.leaseMs ?? DEFAULT_TASK_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_CAS_ATTEMPTS;
  let lastConflict: TaskWriteConflictError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const observedAt = now();
    const current = await port.readTask(task);
    if (
      current?.lease &&
      current.lease.owner !== owner &&
      leaseIsLive(current.lease, observedAt)
    ) {
      throw new TaskLeaseBusyError(task, current.lease);
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
