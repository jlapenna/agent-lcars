/**
 * The `RecoveryOperationPort` contract suite, mirroring `./port.contract.ts`'s
 * shape and reason for existing: a future durable backend proves itself safe
 * to swap in by passing this same suite, called from its own `<backend>.spec.ts`
 * with a factory that builds it -- see that file's header for the full
 * rationale, which applies here unchanged.
 *
 * Covers: record-then-resolve, idempotent re-record and re-resolve (the
 * at-least-once delivery property #864 requires), a reused key with a
 * genuinely different observation still returning the first one, resolving
 * before recording (misuse), and overwriting a terminal resolution (misuse).
 */

import assert from 'node:assert/strict';

import type { RecoveryObservation } from '@agent-lcars/dispatch-contracts';
import { buildRecoveryObservation } from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import {
  RecoveryOperationAlreadyResolvedError,
  RecoveryOperationNotRecordedError,
  type RecoveryOperationPort,
} from './recovery-port';

function observationFixture(
  overrides: Partial<Parameters<typeof buildRecoveryObservation>[0]> = {},
): RecoveryObservation {
  return buildRecoveryObservation({
    target: {
      domain: 'pr_healing',
      repositoryId: 42,
      repository: 'supersprinklesracing/sprinkles',
      anchor: 4321,
      exactIdentity: 'pr:4321:abc123',
    },
    sourceKind: 'webhook',
    observedAt: '2026-08-09T00:00:00.000Z',
    evidence: 'https://example.invalid/evidence',
    ...overrides,
  });
}

export function runRecoveryOperationPortContractSuite(
  makePort: () => RecoveryOperationPort | Promise<RecoveryOperationPort>,
): void {
  test('records a new observation as pending', async () => {
    const port = await makePort();
    const observation = observationFixture();
    const recorded = await port.recordObservation(observation);
    assert.equal(recorded.operationKey, observation.operationKey);
    assert.equal(recorded.status, 'pending');
    assert.deepEqual(recorded.observation, observation);
  });

  test('read-your-writes: readRecoveryOperation observes a prior recordObservation', async () => {
    const port = await makePort();
    const observation = observationFixture();
    await port.recordObservation(observation);
    const read = await port.readRecoveryOperation(observation.operationKey);
    assert.equal(read?.operationKey, observation.operationKey);
    assert.equal(read?.status, 'pending');
  });

  test('readRecoveryOperation returns undefined for an unknown key', async () => {
    const port = await makePort();
    const read = await port.readRecoveryOperation(
      'recovery/v1:ci_retry:1:1:run:1:1',
    );
    assert.equal(read, undefined);
  });

  test('recordObservation is idempotent: a duplicate observation of the same key returns the FIRST one unchanged', async () => {
    const port = await makePort();
    const first = observationFixture({
      sourceKind: 'webhook',
      evidence: 'https://example.invalid/first',
    });
    const second = observationFixture({
      sourceKind: 'schedule',
      evidence: 'https://example.invalid/second',
    });
    assert.equal(first.operationKey, second.operationKey);

    const recordedFirst = await port.recordObservation(first);
    const recordedSecond = await port.recordObservation(second);

    assert.deepEqual(recordedSecond, recordedFirst);
    assert.equal(recordedSecond.observation.sourceKind, 'webhook');
    assert.equal(
      recordedSecond.observation.evidence,
      'https://example.invalid/first',
    );
  });

  test('resolveRecoveryOperation moves a pending operation to a terminal status', async () => {
    const port = await makePort();
    const observation = observationFixture();
    await port.recordObservation(observation);
    const resolved = await port.resolveRecoveryOperation(
      observation.operationKey,
      'executed',
    );
    assert.equal(resolved.status, 'executed');
    assert.ok(resolved.resolvedAt);
    const read = await port.readRecoveryOperation(observation.operationKey);
    assert.equal(read?.status, 'executed');
  });

  test('resolveRecoveryOperation carries an optional detail through', async () => {
    const port = await makePort();
    const observation = observationFixture();
    await port.recordObservation(observation);
    const resolved = await port.resolveRecoveryOperation(
      observation.operationKey,
      'failed',
      'GitHub API returned 500',
    );
    assert.equal(resolved.status, 'failed');
    assert.equal(resolved.detail, 'GitHub API returned 500');
  });

  test('resolveRecoveryOperation throws RecoveryOperationNotRecordedError for an unrecorded key', async () => {
    const port = await makePort();
    await assert.rejects(
      port.resolveRecoveryOperation(
        'recovery/v1:ci_retry:1:1:run:1:1',
        'executed',
      ),
      RecoveryOperationNotRecordedError,
    );
  });

  test('resolveRecoveryOperation is idempotent for a retried resolve with the same status and detail', async () => {
    const port = await makePort();
    const observation = observationFixture();
    await port.recordObservation(observation);
    const first = await port.resolveRecoveryOperation(
      observation.operationKey,
      'executed',
      'ok',
    );
    const second = await port.resolveRecoveryOperation(
      observation.operationKey,
      'executed',
      'ok',
    );
    assert.deepEqual(second, first);
  });

  test('resolveRecoveryOperation throws RecoveryOperationAlreadyResolvedError when re-resolving to a different status', async () => {
    const port = await makePort();
    const observation = observationFixture();
    await port.recordObservation(observation);
    await port.resolveRecoveryOperation(observation.operationKey, 'executed');
    await assert.rejects(
      port.resolveRecoveryOperation(
        observation.operationKey,
        'skipped_duplicate',
      ),
      RecoveryOperationAlreadyResolvedError,
    );
  });

  test('resolveRecoveryOperation throws RecoveryOperationAlreadyResolvedError when re-resolving with a different detail', async () => {
    const port = await makePort();
    const observation = observationFixture();
    await port.recordObservation(observation);
    await port.resolveRecoveryOperation(
      observation.operationKey,
      'failed',
      'first reason',
    );
    await assert.rejects(
      port.resolveRecoveryOperation(
        observation.operationKey,
        'failed',
        'second reason',
      ),
      RecoveryOperationAlreadyResolvedError,
    );
  });

  test('listPendingRecoveryOperations returns only pending operations, resolved ones excluded', async () => {
    const port = await makePort();
    const pending = observationFixture({
      target: {
        domain: 'ci_retry',
        repositoryId: 1,
        repository: 'jlapenna/homelab',
        anchor: 9,
        exactIdentity: 'run:1:1',
      },
    });
    const resolved = observationFixture({
      target: {
        domain: 'ci_retry',
        repositoryId: 1,
        repository: 'jlapenna/homelab',
        anchor: 9,
        exactIdentity: 'run:2:1',
      },
    });
    await port.recordObservation(pending);
    await port.recordObservation(resolved);
    await port.resolveRecoveryOperation(resolved.operationKey, 'executed');

    const pendingList = await port.listPendingRecoveryOperations();
    const keys = pendingList.map((operation) => operation.operationKey);
    assert.ok(keys.includes(pending.operationKey));
    assert.ok(!keys.includes(resolved.operationKey));
  });

  test('listPendingRecoveryOperations is empty when nothing has been recorded', async () => {
    const port = await makePort();
    const pendingList = await port.listPendingRecoveryOperations();
    assert.deepEqual(pendingList, []);
  });
}
