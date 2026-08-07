/**
 * Unit tests for the dispatch-storage shadow-mode switch and observer
 * (./shadow.ts). See that file's own header for the design this proves:
 * `'off'` is provably inert, `'shadow'` never fails a dispatch even when
 * storage throws, and a divergence is logged with both values.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { acceptIntent, beginDispatch, createLedger } from '../broker.js';
import { InMemoryStoragePort } from './in-memory-port.js';
import type { StoragePort, StoredTask, TaskRef } from './port.js';
import {
  diffStoredTask,
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
// Divergence detection.
// ---------------------------------------------------------------------------

test('diffStoredTask reports no divergence when nothing has been observed yet', () => {
  const desired = projectLedgerToStoredTask(ledgerWithAcceptedIntent());
  assert.deepEqual(diffStoredTask(undefined, desired), []);
});

test('diffStoredTask reports no divergence when storage already agrees with the ledger', () => {
  const desired = projectLedgerToStoredTask(ledgerWithAcceptedIntent());
  const before: StoredTask = {
    task,
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...desired,
  };
  assert.deepEqual(diffStoredTask(before, desired), []);
});

test('a divergence is detected and logged with both the ledger value and the stored value', async () => {
  const port = new InMemoryStoragePort();
  // Seed storage with a stale baseline: a DIFFERENT desiredIntentId than
  // what the ledger currently says.
  await port.writeTask(task, undefined, {
    desiredIntentId: 'intent-stale',
    signals: [],
    intents: [],
  });

  const ledger = ledgerWithAcceptedIntent();

  const { logs, restore } = captureLogs();
  try {
    await observeDispatchStorage(port, ledger, '2026-08-01T00:05:00.000Z');
  } finally {
    restore();
  }

  const warnings = logs.filter((line) => line.startsWith('::warning::'));
  // The seeded baseline had no signals and no intents at all, so all three
  // fields diverge from the accepted-intent ledger's projection.
  assert.equal(warnings.length, 3);

  const desiredIntentIdWarning = warnings.find((line) =>
    line.includes("field 'desiredIntentId'"),
  );
  assert.ok(desiredIntentIdWarning, 'must name the diverging field');
  assert.match(desiredIntentIdWarning as string, /jlapenna\/agent-lcars#645/u);
  assert.match(desiredIntentIdWarning as string, /ledger="intent-1"/u);
  assert.match(desiredIntentIdWarning as string, /storage="intent-stale"/u);

  const intentsWarning = warnings.find((line) =>
    line.includes("field 'intents'"),
  );
  assert.ok(intentsWarning, 'must name the diverging intents field');
  assert.match(intentsWarning as string, /ledger=\[.*"intentId":"intent-1"/u);
  assert.match(intentsWarning as string, /storage=\[\]/u);
});

test('diffStoredTask reports which specific fields diverge, not just that something did', () => {
  const before: StoredTask = {
    task,
    revision: 3,
    updatedAt: '2026-08-01T00:00:00.000Z',
    desiredIntentId: 'intent-1',
    signals: [
      {
        sourceKind: 'manual',
        sourceId: 'source-1',
        occurredAt: '2026-08-01T00:00:00.000Z',
        authorization: { authorized: true },
      },
    ],
    intents: [],
  };
  const desired = projectLedgerToStoredTask(ledgerWithAcceptedIntent());

  const divergences = diffStoredTask(before, desired);
  const fields = divergences.map((divergence) => divergence.field).sort();
  // desiredIntentId agrees ('intent-1' both sides); signals and intents
  // differ (stored has an extra/different signal, no intents at all).
  assert.deepEqual(fields, ['intents', 'signals']);
});
