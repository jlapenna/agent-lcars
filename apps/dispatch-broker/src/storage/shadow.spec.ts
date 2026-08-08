/**
 * Unit tests for the dispatch-storage shadow-mode switch and observer
 * (./shadow.ts). See that file's own header for the design this proves:
 * `'off'` is provably inert, `'shadow'` never fails a dispatch even when
 * storage throws, a genuine storage-integrity anomaly (a round-trip
 * mismatch, a CAS conflict) is logged with both values, an ORDINARY
 * pass-to-pass ledger transition never is, and observational evidence is
 * projected as observational, never fabricated into an authorization
 * decision.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  acceptIntent,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  recordControlEvidence,
} from '../broker.js';
import { InMemoryStoragePort } from './in-memory-port.js';
import type { StoragePort, StoredTask, TaskRef } from './port.js';
import {
  checkRoundTrip,
  maybeObserveDispatchStorage,
  observeDispatchStorage,
  parseDispatchStorageMode,
  projectLedgerToStoredTask,
} from './shadow.js';

const task: TaskRef = {
  repositoryId: 1307149765,
  repository: 'jlapenna/agent-lcars',
  issue: 645,
};

function ledgerWithAcceptedIntent() {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-1',
    sourceKind: 'manual',
    sourceId: 'source-1',
    transportRunId: 9001,
    occurredAt: '2026-08-01T00:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'abc',
    authorization: { authorized: true, actor: 'jlapenna', rule: 'maintainer' },
  });
  return ledger;
}

function captureLogs() {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: string) => logs.push(message);
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

/** A port whose every method throws -- used to prove 'off' never touches
 *  storage at all: if any method were ever called, the throw would surface
 *  through the (unwrapped) createPort factory or the call itself, either
 *  of which the assertions below would catch. */
function throwingPort(): StoragePort {
  const boom = () => {
    throw new Error('storage port must not be called');
  };
  return {
    readTask: boom,
    writeTask: boom,
    recordLaunchIntent: boom,
    resolveLaunchOutcome: boom,
    readLaunchOperation: boom,
    listPendingLaunchOperations: boom,
  };
}

/** Delegates every method to a real `InMemoryStoragePort`, except its
 *  SECOND `readTask` call -- `observeDispatchStorage`'s post-write
 *  read-back -- which is passed through `corrupt` instead of the real
 *  result. Simulates a storage backend that accepted a write but hands a
 *  different value back to the very next reader (a broken (de)serializer,
 *  or a partial write). */
function readTaskCorruptingPort(
  corrupt: (stored: StoredTask) => StoredTask | undefined,
): StoragePort {
  const inner = new InMemoryStoragePort();
  let readCount = 0;
  return {
    async readTask(task: TaskRef) {
      readCount += 1;
      const result = await inner.readTask(task);
      return readCount === 2 && result ? corrupt(result) : result;
    },
    writeTask: (task, expectedRevision, next, now) =>
      inner.writeTask(task, expectedRevision, next, now),
    recordLaunchIntent: (operation, now) =>
      inner.recordLaunchIntent(operation, now),
    resolveLaunchOutcome: (operationId, resolution, now) =>
      inner.resolveLaunchOutcome(operationId, resolution, now),
    readLaunchOperation: (operationId) =>
      inner.readLaunchOperation(operationId),
    listPendingLaunchOperations: () => inner.listPendingLaunchOperations(),
  };
}

/** Delegates every method to a real `InMemoryStoragePort`, except that its
 *  `readTask` call writes a conflicting change to the SAME task, via the
 *  underlying port directly, immediately after observing the "before"
 *  state and before returning it -- simulating a second writer landing in
 *  the exact gap `observeDispatchStorage`'s own read-then-write is meant to
 *  close. The subsequent `writeTask` call this pass makes, using the
 *  now-stale revision it read, must then hit a genuine
 *  `TaskWriteConflictError`. */
function racingWriterPort(): StoragePort {
  const inner = new InMemoryStoragePort();
  return {
    async readTask(task: TaskRef) {
      const before = await inner.readTask(task);
      await inner.writeTask(task, before?.revision, {
        desiredIntentId: 'someone-elses-write',
        signals: [],
        intents: [],
      });
      return before;
    },
    writeTask: (task, expectedRevision, next, now) =>
      inner.writeTask(task, expectedRevision, next, now),
    recordLaunchIntent: (operation, now) =>
      inner.recordLaunchIntent(operation, now),
    resolveLaunchOutcome: (operationId, resolution, now) =>
      inner.resolveLaunchOutcome(operationId, resolution, now),
    readLaunchOperation: (operationId) =>
      inner.readLaunchOperation(operationId),
    listPendingLaunchOperations: () => inner.listPendingLaunchOperations(),
  };
}

// ---------------------------------------------------------------------------
// parseDispatchStorageMode
// ---------------------------------------------------------------------------

test('parseDispatchStorageMode treats unset as off', () => {
  assert.equal(parseDispatchStorageMode(undefined), 'off');
});

test('parseDispatchStorageMode treats an empty repo variable as off', () => {
  assert.equal(parseDispatchStorageMode(''), 'off');
});

test('parseDispatchStorageMode accepts off explicitly', () => {
  assert.equal(parseDispatchStorageMode('off'), 'off');
});

test('parseDispatchStorageMode accepts shadow', () => {
  assert.equal(parseDispatchStorageMode('shadow'), 'shadow');
});

test('parseDispatchStorageMode rejects an unrecognised value loudly rather than silently treating it as off', () => {
  assert.throws(
    () => parseDispatchStorageMode('authoritative'),
    /Unrecognized DISPATCH_STORAGE_MODE/u,
  );
  assert.throws(() => parseDispatchStorageMode('On'), /Unrecognized/u);
  assert.throws(() => parseDispatchStorageMode('true'), /Unrecognized/u);
});

// ---------------------------------------------------------------------------
// 'off' is provably inert.
// ---------------------------------------------------------------------------

test('maybeObserveDispatchStorage in off mode never constructs a port or makes a storage call', async () => {
  const ledger = ledgerWithAcceptedIntent();
  let createPortCalled = false;
  const createPort = () => {
    createPortCalled = true;
    return throwingPort();
  };

  await maybeObserveDispatchStorage('off', createPort, ledger);

  assert.equal(
    createPortCalled,
    false,
    'off must never invoke the port factory at all',
  );
});

test('maybeObserveDispatchStorage in off mode leaves the ledger untouched', async () => {
  const ledger = ledgerWithAcceptedIntent();
  const before = JSON.stringify(ledger);

  await maybeObserveDispatchStorage('off', throwingPort, ledger);

  assert.equal(JSON.stringify(ledger), before);
});

// ---------------------------------------------------------------------------
// Shadow mode writes to storage and never touches the ledger path.
// ---------------------------------------------------------------------------

test('observeDispatchStorage writes the projected state to storage and leaves the ledger byte-identical', async () => {
  const ledger = ledgerWithAcceptedIntent();
  const before = JSON.stringify(ledger);
  const port = new InMemoryStoragePort();

  await observeDispatchStorage(port, ledger, '2026-08-01T00:05:00.000Z');

  // The ledger -- the authoritative comment-ledger path -- is never mutated
  // by shadow observation.
  assert.equal(JSON.stringify(ledger), before);

  // Storage received the write.
  const stored = await port.readTask(task);
  assert.ok(stored, 'storage must hold the observed task after a write');
  assert.equal(stored?.revision, 1);
  assert.deepEqual(stored?.intents[0]?.intentId, 'intent-1');
  assert.equal(stored?.desiredIntentId, 'intent-1');
});

test('projectLedgerToStoredTask never mutates the ledger it reads', () => {
  const ledger = ledgerWithAcceptedIntent();
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  const before = JSON.stringify(ledger);

  projectLedgerToStoredTask(ledger);

  assert.equal(JSON.stringify(ledger), before);
});

test('projectLedgerToStoredTask prefers the active generation, falling back to pending, then accepted', () => {
  const ledger = ledgerWithAcceptedIntent();
  const acceptedOnly = projectLedgerToStoredTask(ledger);
  assert.equal(acceptedOnly.desiredIntentId, 'intent-1');
  assert.equal(acceptedOnly.intents[0]?.state, 'accepted');

  beginDispatch(ledger, 1, 'dispatch_token_123456');
  const dispatching = projectLedgerToStoredTask(ledger);
  assert.equal(dispatching.desiredIntentId, 'intent-1');
  assert.equal(dispatching.intents[0]?.state, 'dispatching');
});

// ---------------------------------------------------------------------------
// A throwing storage port never changes the dispatch outcome.
// ---------------------------------------------------------------------------

test('maybeObserveDispatchStorage in shadow mode swallows a throwing port and never rethrows', async () => {
  const ledger = ledgerWithAcceptedIntent();
  const before = JSON.stringify(ledger);

  const { logs, restore } = captureLogs();
  try {
    // Must resolve, not reject -- this is the whole containment property.
    await maybeObserveDispatchStorage('shadow', throwingPort, ledger);
  } finally {
    restore();
  }

  // The ledger path is unaffected by the failure.
  assert.equal(JSON.stringify(ledger), before);

  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dispatch-storage shadow observation failed/u);
  assert.match(warnings[0], /storage port must not be called/u);
});

test('maybeObserveDispatchStorage in shadow mode also contains a port-construction failure', async () => {
  const ledger = ledgerWithAcceptedIntent();
  const createPort = (): StoragePort => {
    throw new Error('token minting failed');
  };

  const { logs, restore } = captureLogs();
  let threw = false;
  try {
    await maybeObserveDispatchStorage('shadow', createPort, ledger);
  } catch {
    threw = true;
  } finally {
    restore();
  }

  assert.equal(threw, false, 'a port-construction failure must not propagate');
  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /token minting failed/u);
});

// ---------------------------------------------------------------------------
// Finding 1 regression: an ordinary pass-to-pass ledger transition must
// never look like a storage-integrity problem.
// ---------------------------------------------------------------------------

test('a normal pass-to-pass transition (active -> completed, a new source, a new generation) produces no divergence warning', async () => {
  const port = new InMemoryStoragePort();
  const ledger = ledgerWithAcceptedIntent();
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  bindRun(ledger, 1, {
    runId: 42,
    runUrl: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    workflow: 'codex.yml',
  });

  const { logs, restore } = captureLogs();
  try {
    // Pass 1: observe while the generation is still active.
    await observeDispatchStorage(port, ledger, '2026-08-01T00:10:00.000Z');

    // Advance the ledger the way a real broker pass would between two
    // observations: a completion callback moves the generation from
    // `active` to `completed`, AND a brand-new intent is accepted (a new
    // source, a new generation) -- exactly finding 1's example of
    // ordinary, expected change that the old before-vs-desired comparison
    // mistook for a defect.
    completeRun(
      ledger,
      1,
      { runId: 42, status: 'completed', conclusion: 'success' },
      '2026-08-01T00:20:00.000Z',
    );
    acceptIntent(ledger, {
      task,
      intentId: 'intent-2',
      sourceKind: 'manual',
      sourceId: 'source-2',
      transportRunId: 9002,
      occurredAt: '2026-08-01T00:21:00.000Z',
      pipeline: 'codex',
      mode: 'implement',
      runbook: '',
      context: '',
      digest: 'def',
      authorization: {
        authorized: true,
        actor: 'jlapenna',
        rule: 'maintainer',
      },
    });

    // Pass 2: observe the post-transition ledger.
    await observeDispatchStorage(port, ledger, '2026-08-01T00:22:00.000Z');
  } finally {
    restore();
  }

  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  assert.deepEqual(
    warnings,
    [],
    'an ordinary ledger transition between two passes must never be reported as a storage-integrity problem',
  );
});

// ---------------------------------------------------------------------------
// checkRoundTrip: the pure comparison, exercised directly.
// ---------------------------------------------------------------------------

function storedTaskFixture(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    task,
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    desiredIntentId: 'intent-1',
    signals: [],
    intents: [],
    ...overrides,
  };
}

test('checkRoundTrip reports nothing when the read-back exactly matches what was written', () => {
  const written = storedTaskFixture();
  assert.deepEqual(checkRoundTrip(written, { ...written }), []);
});

test('checkRoundTrip reports a revision divergence, expected vs undefined, when storage has nothing for a task it was just told to write', () => {
  const written = storedTaskFixture();
  assert.deepEqual(checkRoundTrip(written, undefined), [
    { field: 'revision', expected: 1, actual: undefined },
  ]);
});

test('checkRoundTrip names each field that differs between what was written and what was read back', () => {
  const written = storedTaskFixture();
  const after = storedTaskFixture({ desiredIntentId: 'intent-2', revision: 2 });

  const divergences = checkRoundTrip(written, after);
  const fields = divergences.map((divergence) => divergence.field).sort();
  assert.deepEqual(fields, ['desiredIntentId', 'revision']);

  const revisionDivergence = divergences.find((d) => d.field === 'revision');
  assert.deepEqual(revisionDivergence, {
    field: 'revision',
    expected: 1,
    actual: 2,
  });
});

// ---------------------------------------------------------------------------
// Round-trip integrity, end to end through observeDispatchStorage.
// ---------------------------------------------------------------------------

test('observeDispatchStorage warns, naming both values, when a fresh read-back differs from what was just written', async () => {
  const port = readTaskCorruptingPort((stored) => ({
    ...stored,
    desiredIntentId: 'corrupted-intent-id',
  }));
  const ledger = ledgerWithAcceptedIntent();

  const { logs, restore } = captureLogs();
  try {
    await observeDispatchStorage(port, ledger, '2026-08-01T00:05:00.000Z');
  } finally {
    restore();
  }

  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dispatch-storage shadow round-trip mismatch/u);
  assert.match(warnings[0], /jlapenna\/agent-lcars#645/u);
  assert.match(warnings[0], /field 'desiredIntentId'/u);
  assert.match(warnings[0], /expected="intent-1"/u);
  assert.match(warnings[0], /actual="corrupted-intent-id"/u);
});

test('observeDispatchStorage warns, naming both values, when storage has nothing for a task it was just told to write (a lost write)', async () => {
  const port = readTaskCorruptingPort(() => undefined);
  const ledger = ledgerWithAcceptedIntent();

  const { logs, restore } = captureLogs();
  try {
    await observeDispatchStorage(port, ledger, '2026-08-01T00:05:00.000Z');
  } finally {
    restore();
  }

  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dispatch-storage shadow round-trip mismatch/u);
  assert.match(warnings[0], /field 'revision'/u);
  assert.match(warnings[0], /expected=1/u);
  assert.match(warnings[0], /actual=undefined/u);
});

// ---------------------------------------------------------------------------
// Compare-and-swap conflict: a second writer is itself the finding, for a
// single-writer control plane.
// ---------------------------------------------------------------------------

test('observeDispatchStorage propagates a genuine compare-and-swap conflict, naming both revisions, rather than swallowing it', async () => {
  const port = racingWriterPort();
  const ledger = ledgerWithAcceptedIntent();

  await assert.rejects(
    () => observeDispatchStorage(port, ledger, '2026-08-01T00:05:00.000Z'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Task write conflict/u);
      assert.match(error.message, /expected revision \(none\)/u);
      assert.match(error.message, /found 1/u);
      return true;
    },
  );
});

test('maybeObserveDispatchStorage in shadow mode contains a compare-and-swap conflict as one warning naming both revisions', async () => {
  const port = racingWriterPort();
  const ledger = ledgerWithAcceptedIntent();

  const { logs, restore } = captureLogs();
  try {
    await maybeObserveDispatchStorage('shadow', () => port, ledger);
  } finally {
    restore();
  }

  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dispatch-storage shadow observation failed/u);
  assert.match(warnings[0], /Task write conflict/u);
  assert.match(warnings[0], /expected revision \(none\)/u);
  assert.match(warnings[0], /found 1/u);
});

// ---------------------------------------------------------------------------
// Finding 2: observational evidence must round-trip as observational, never
// as a fabricated authorization decision.
// ---------------------------------------------------------------------------

test('projectLedgerToStoredTask maps a real authorization decision to a decision record', () => {
  const projected = projectLedgerToStoredTask(ledgerWithAcceptedIntent());
  const signal = projected.signals[0];
  assert.deepEqual(signal.authorization, {
    authorized: true,
    actor: 'jlapenna',
    rule: 'maintainer',
  });
});

test('projectLedgerToStoredTask maps observational evidence to an observation record, never an authorization decision', () => {
  const ledger = ledgerWithAcceptedIntent();
  // The exact shape main.ts's completion-callback handler records: observed
  // evidence, no authorization decision at all (ledger.ts's
  // LedgerAuthorizationObservation).
  recordControlEvidence(ledger, {
    sourceKind: 'completion',
    sourceId: 'completion-1',
    occurredAt: '2026-08-01T00:15:00.000Z',
    authorization: { observed: true, workflow: 'codex.yml' },
  });

  const projected = projectLedgerToStoredTask(ledger);
  const completionSignal = projected.signals.find(
    (signal) => signal.sourceKind === 'completion',
  );
  assert.ok(completionSignal, 'the completion source must be projected');
  assert.deepEqual(completionSignal?.authorization, {
    observed: true,
    actor: undefined,
    workflow: 'codex.yml',
  });
  assert.equal(
    'authorized' in (completionSignal?.authorization ?? {}),
    false,
    'observational evidence must never carry a fabricated authorized key',
  );
});

test('observational evidence round-trips through actual storage as observational, never as authorized', async () => {
  const port = new InMemoryStoragePort();
  const ledger = ledgerWithAcceptedIntent();
  recordControlEvidence(ledger, {
    sourceKind: 'closed',
    sourceId: 'anchor-closed-1',
    occurredAt: '2026-08-01T00:16:00.000Z',
    authorization: { observed: true, actor: 'jlapenna' },
  });

  await observeDispatchStorage(port, ledger, '2026-08-01T00:16:30.000Z');

  const stored = await port.readTask(task);
  const closedSignal = stored?.signals.find(
    (signal) => signal.sourceKind === 'closed',
  );
  assert.ok(closedSignal, 'the anchor-closed source must be stored');
  assert.deepEqual(closedSignal?.authorization, {
    observed: true,
    actor: 'jlapenna',
    workflow: undefined,
  });
  assert.equal(
    'authorized' in (closedSignal?.authorization ?? {}),
    false,
    'storage must not hold a fabricated authorization decision for observed evidence',
  );
});
