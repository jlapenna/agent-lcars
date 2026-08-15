import 'server-only';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  TaskAuthorityScope,
} from './authority-storage';
import type { TaskLeaseRunner } from './signal-task-composition';

/** Server-owned configuration for the callback-oriented task lease runner. */
export interface StorageTaskLeaseRunnerOptions {
  storage: LifecycleAuthorityStorage;
  clock: AuthorityClock;
  ownerId: string;
  leaseDurationMs: number;
}

/**
 * Raised when storage reports that a lease release was not applied.
 *
 * A release returning false is a failed release even though the storage
 * boundary uses a boolean to distinguish it from an exception. Treating it as
 * an error prevents a callback from appearing successful after its authority
 * was not relinquished.
 */
export class TaskLeaseReleaseError extends Error {
  override name = 'TaskLeaseReleaseError';
}

class TaskLeaseValidationError extends Error {
  override name = 'TaskLeaseValidationError';
}

function scopeKey(scope: TaskAuthorityScope): string {
  // Use an ordered tuple rather than JSON.stringify(scope): callers may build
  // equivalent scope objects with different property insertion order.
  return JSON.stringify([
    scope.tenantId,
    scope.repositoryId,
    scope.issueNumber,
  ]);
}

function canonicalUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validatedLease(
  value: unknown,
  scope: TaskAuthorityScope,
  ownerId: string,
): TaskAuthorityLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskLeaseValidationError(
      'Storage returned a malformed task lease',
    );
  }
  const candidate = value as Partial<TaskAuthorityLease>;
  if (
    typeof candidate.taskKey !== 'string' ||
    candidate.taskKey !== scopeKey(scope) ||
    typeof candidate.ownerId !== 'string' ||
    candidate.ownerId !== ownerId ||
    typeof candidate.fence !== 'number' ||
    !Number.isSafeInteger(candidate.fence) ||
    candidate.fence <= 0 ||
    !canonicalUtcTimestamp(candidate.acquiredAt) ||
    !canonicalUtcTimestamp(candidate.expiresAt) ||
    Date.parse(candidate.expiresAt) <= Date.parse(candidate.acquiredAt)
  ) {
    throw new TaskLeaseValidationError(
      'Storage returned a task lease outside the requested authority scope',
    );
  }

  // Do not expose or retain the storage-owned object. Only the validated
  // primitive lease fields cross into the callback and release boundary.
  return Object.freeze({
    taskKey: candidate.taskKey,
    ownerId: candidate.ownerId,
    fence: candidate.fence,
    acquiredAt: candidate.acquiredAt,
    expiresAt: candidate.expiresAt,
  });
}

function attachReleaseFailure(primary: unknown, releaseError: unknown): void {
  if (!(primary instanceof Error) || 'cause' in primary) return;
  try {
    Object.defineProperty(primary, 'cause', {
      configurable: true,
      enumerable: false,
      value: releaseError,
      writable: true,
    });
  } catch {
    // Frozen or host-owned errors still preserve the primary failure below.
  }
}

/**
 * Serializes callback lifetimes per task scope while allowing unrelated task
 * scopes to proceed independently. The callback never receives a caller
 * supplied lease and the acquired lease is always released before completion.
 */
export class StorageTaskLeaseRunner implements TaskLeaseRunner {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly storage: LifecycleAuthorityStorage;
  private readonly clock: AuthorityClock;
  private readonly ownerId: string;
  private readonly leaseDurationMs: number;

  constructor(options: StorageTaskLeaseRunnerOptions) {
    this.storage = options.storage;
    this.clock = options.clock;
    this.ownerId = options.ownerId;
    this.leaseDurationMs = options.leaseDurationMs;
  }

  run<T>(
    scope: TaskAuthorityScope,
    operation: (lease: TaskAuthorityLease) => Promise<T>,
  ): Promise<T> {
    const requestedScope: TaskAuthorityScope = {
      tenantId: scope.tenantId,
      repositoryId: scope.repositoryId,
      issueNumber: scope.issueNumber,
    };
    const key = scopeKey(requestedScope);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(() =>
      this.execute(requestedScope, operation),
    );
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return current;
  }

  private async execute<T>(
    scope: TaskAuthorityScope,
    operation: (lease: TaskAuthorityLease) => Promise<T>,
  ): Promise<T> {
    const lease = validatedLease(
      await this.storage.acquireTaskLease({
        scope,
        ownerId: this.ownerId,
        leaseDurationMs: this.leaseDurationMs,
      }),
      scope,
      this.ownerId,
    );

    // Keep the lease identity stable for release and prevent the callback from
    // changing owner/fence/scope authority before the release boundary runs.
    // `validatedLease` already cloned and froze the storage result.
    const callbackLease = lease;

    let callbackFailed = false;
    let callbackError: unknown;
    let result!: T;
    try {
      const now = this.clock.now();
      if (
        !canonicalUtcTimestamp(now) ||
        Date.parse(now) < Date.parse(callbackLease.acquiredAt) ||
        Date.parse(now) >= Date.parse(callbackLease.expiresAt)
      ) {
        throw new TaskLeaseValidationError(
          'Storage returned a task lease that is not active at callback entry',
        );
      }
      result = await operation(callbackLease);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }

    let releaseFailed = false;
    let releaseError: unknown;
    try {
      const released = await this.storage.releaseTaskLease(callbackLease);
      if (released !== true) {
        throw new TaskLeaseReleaseError('Task lease release was not applied');
      }
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }

    // A callback failure is the primary operation result. Release errors must
    // not replace it; on callback success, release failure is thrown.
    if (callbackFailed) {
      if (releaseFailed) attachReleaseFailure(callbackError, releaseError);
      throw callbackError;
    }
    if (releaseFailed) throw releaseError;
    return result;
  }
}
