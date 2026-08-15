// This test intentionally imports the package entrypoint to lock the
// published construction surface.
// eslint-disable-next-line @nx/enforce-module-boundaries
import * as api from '@agent-lcars/lifecycle-control-plane';
import { describe, expect, it, vi } from 'vitest';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  TaskAuthorityScope,
} from './authority-storage';
import {
  StorageTaskLeaseRunner,
  TaskLeaseReleaseError,
} from './task-lease-runner';

const scope: TaskAuthorityScope = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  issueNumber: 9,
};
const otherScope: TaskAuthorityScope = {
  ...scope,
  issueNumber: 10,
};
const lease: TaskAuthorityLease = {
  taskKey: '["tenant-1",123,9]',
  ownerId: 'runner-1',
  fence: 4,
  acquiredAt: '2026-08-14T00:00:00.000Z',
  expiresAt: '2026-08-14T01:00:00.000Z',
};
const clock = { now: () => '2026-08-14T00:30:00.000Z' };

function storageFixture() {
  const acquireTaskLease = vi.fn(async () => ({ ...lease }));
  const releaseTaskLease = vi.fn(async () => true);
  const storage = {
    acquireTaskLease,
    releaseTaskLease,
  } as unknown as LifecycleAuthorityStorage;
  return { storage, acquireTaskLease, releaseTaskLease };
}

describe('StorageTaskLeaseRunner', () => {
  it('forwards server-owned configuration, orders acquire/callback/release, and returns the exact result', async () => {
    const test = storageFixture();
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });
    const order: string[] = [];
    const result = { accepted: true };

    const returned = await runner.run(scope, async (received) => {
      order.push('callback');
      expect(received).toEqual(lease);
      expect(Object.isFrozen(received)).toBe(true);
      return result;
    });

    expect(returned).toBe(result);
    expect(test.acquireTaskLease).toHaveBeenCalledExactlyOnceWith({
      scope,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });
    expect(test.releaseTaskLease).toHaveBeenCalledExactlyOnceWith(lease);
    expect(order).toEqual(['callback']);
  });

  it('does not invoke callback or release when acquisition fails', async () => {
    const test = storageFixture();
    const acquisitionError = new Error('acquisition failed');
    test.acquireTaskLease.mockRejectedValueOnce(acquisitionError);
    const operation = vi.fn(async () => 'unreachable');
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });

    await expect(runner.run(scope, operation)).rejects.toBe(acquisitionError);
    expect(operation).not.toHaveBeenCalled();
    expect(test.releaseTaskLease).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['empty', {}],
    ['wrong task scope', { ...lease, taskKey: '["tenant-1",123,10]' }],
    ['wrong owner', { ...lease, ownerId: 'other-owner' }],
    ['invalid fence', { ...lease, fence: 0 }],
    ['invalid acquired timestamp', { ...lease, acquiredAt: 'not-a-time' }],
    [
      'expired timestamp',
      {
        ...lease,
        expiresAt: '2026-08-13T23:00:00.000Z',
      },
    ],
  ])('rejects a %s lease before callback or release', async (_name, value) => {
    const test = storageFixture();
    test.acquireTaskLease.mockResolvedValue(value as never);
    const operation = vi.fn(async () => 'unreachable');
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });

    await expect(runner.run(scope, operation)).rejects.toThrow(
      /Storage returned .* task lease/iu,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(test.releaseTaskLease).not.toHaveBeenCalled();
  });

  it('clones the validated lease and snapshots configuration and queued scope identity', async () => {
    const test = storageFixture();
    const rawLease = { ...lease };
    test.acquireTaskLease.mockResolvedValue(rawLease);
    const options = {
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    };
    const runner = new StorageTaskLeaseRunner(options);
    const mutableScope = { ...scope };
    const result = runner.run(mutableScope, async (received) => {
      expect(received).not.toBe(rawLease);
      expect(Object.isFrozen(received)).toBe(true);
      return 'ok';
    });
    mutableScope.issueNumber = 10;
    options.ownerId = 'mutated-owner';
    options.leaseDurationMs = 1;

    await expect(result).resolves.toBe('ok');
    expect(test.acquireTaskLease).toHaveBeenCalledExactlyOnceWith({
      scope,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });
    expect(test.releaseTaskLease).toHaveBeenCalledExactlyOnceWith(lease);
    expect(rawLease).not.toEqual(
      expect.objectContaining({
        taskKey: 'mutated-task-key',
      }),
    );
    expect(Object.isFrozen(rawLease)).toBe(false);
  });

  it.each([
    ['expired', lease.expiresAt],
    ['not started', '2026-08-13T23:59:59.999Z'],
    ['malformed clock', 'not-a-time'],
  ])(
    'rejects and releases a lease that is %s at callback entry',
    async (_name, now) => {
      const test = storageFixture();
      const operation = vi.fn(async () => 'unreachable');
      const runner = new StorageTaskLeaseRunner({
        storage: test.storage,
        clock: { now: () => now },
        ownerId: 'runner-1',
        leaseDurationMs: 30_000,
      });

      await expect(runner.run(scope, operation)).rejects.toThrow(
        /not active at callback entry/iu,
      );
      expect(operation).not.toHaveBeenCalled();
      expect(test.releaseTaskLease).toHaveBeenCalledExactlyOnceWith(lease);
    },
  );

  it('releases before rethrowing callback failure', async () => {
    const test = storageFixture();
    const callbackError = new Error('callback failed');
    const order: string[] = [];
    test.releaseTaskLease.mockImplementation(async () => {
      order.push('release');
      return true;
    });
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });

    await expect(
      runner.run(scope, async () => {
        order.push('callback');
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    expect(order).toEqual(['callback', 'release']);
  });

  it('throws release failure after callback success', async () => {
    const test = storageFixture();
    const releaseError = new Error('release failed');
    test.releaseTaskLease.mockRejectedValueOnce(releaseError);
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });

    await expect(runner.run(scope, async () => 'ok')).rejects.toBe(
      releaseError,
    );
  });

  it('uses a deterministic release error for a false release and preserves callback failure precedence', async () => {
    const test = storageFixture();
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });

    for (const releaseResult of [false, { applied: true }]) {
      test.releaseTaskLease.mockResolvedValue(releaseResult as never);
      await expect(runner.run(scope, async () => 'ok')).rejects.toBeInstanceOf(
        TaskLeaseReleaseError,
      );
    }
    test.releaseTaskLease.mockResolvedValue({ applied: true } as never);
    const callbackError = new Error('primary');
    await expect(
      runner.run(scope, async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    expect(callbackError.cause).toBeInstanceOf(TaskLeaseReleaseError);
  });

  it('serializes same-scope callbacks and releases each lease before the next acquire', async () => {
    const test = storageFixture();
    const events: string[] = [];
    let unblock!: () => void;
    const firstCallback = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });
    const first = runner.run(scope, async () => {
      events.push('first-callback');
      await firstCallback;
      events.push('first-done');
      return 1;
    });
    const second = runner.run(scope, async () => {
      events.push('second-callback');
      return 2;
    });
    await vi.waitFor(() => expect(events).toEqual(['first-callback']));
    expect(test.acquireTaskLease).toHaveBeenCalledOnce();
    expect(events).toEqual(['first-callback']);
    unblock();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(test.acquireTaskLease).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['first-callback', 'first-done', 'second-callback']);
    expect(test.releaseTaskLease).toHaveBeenCalledTimes(2);
  });

  it('allows different scopes to execute independently', async () => {
    const test = storageFixture();
    test.acquireTaskLease.mockImplementation(async (input) => ({
      ...lease,
      taskKey: JSON.stringify([
        input.scope.tenantId,
        input.scope.repositoryId,
        input.scope.issueNumber,
      ]),
    }));
    const runner = new StorageTaskLeaseRunner({
      storage: test.storage,
      clock,
      ownerId: 'runner-1',
      leaseDurationMs: 30_000,
    });
    let unblock!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const first = runner.run(scope, async () => firstBlocked.then(() => 'one'));
    const second = runner.run(otherScope, async () => 'two');
    await expect(second).resolves.toBe('two');
    expect(test.acquireTaskLease).toHaveBeenCalledTimes(2);
    unblock();
    await expect(first).resolves.toBe('one');
  });

  it('exposes the safe runner construction surface from the package root', () => {
    expect(api.StorageTaskLeaseRunner).toBe(StorageTaskLeaseRunner);
    expect('TaskLeaseReleaseError' in api).toBe(false);
    const storage = {} as api.LifecycleAuthorityStorage;
    const runner = new api.StorageTaskLeaseRunner({
      storage,
      clock,
      ownerId: 'server-owned',
      leaseDurationMs: 1_000,
    });
    expect(runner).toBeInstanceOf(StorageTaskLeaseRunner);
  });
});
