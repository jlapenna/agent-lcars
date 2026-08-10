import { describe, expect, it } from 'vitest';

import { type DispatchLedger, LEDGER_SCHEMA } from './ledger';
import {
  AUTHORITATIVE_TASK_STATE_SCHEMA,
  isAuthoritativeTaskState,
  redactAuthoritativeTaskState,
} from './task-state';

function state() {
  const controllerState: DispatchLedger = {
    schema: LEDGER_SCHEMA,
    revision: 3,
    task: {
      repositoryId: 1_307_149_765,
      repository: 'jlapenna/agent-lcars',
      issue: 824,
    },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:01:00.000Z',
    control: { closed: false },
    sources: [],
    generations: [
      {
        generation: 1,
        intentId: 'intent-1',
        sourceId: 'source-1',
        occurredAt: '2026-08-09T00:00:00.000Z',
        pipeline: 'codex',
        state: 'active',
        attempt: { token: 'private-capability', runId: 42 },
      },
    ],
    anomalies: [],
  };
  return {
    schema: AUTHORITATIVE_TASK_STATE_SCHEMA,
    task: controllerState.task,
    storageRevision: 9,
    updatedAt: '2026-08-09T00:01:01.000Z',
    controllerState,
  };
}

describe('authoritative task-state read contract', () => {
  it('redacts the attempt capability without mutating stored state', () => {
    const original = state();
    const redacted = redactAuthoritativeTaskState(original);
    expect(
      redacted.controllerState.generations[0].attempt?.token,
    ).toBeUndefined();
    expect(original.controllerState.generations[0].attempt?.token).toBe(
      'private-capability',
    );
    expect(isAuthoritativeTaskState(redacted)).toBe(true);
  });

  it('rejects an ad-hoc or malformed lifecycle representation', () => {
    expect(isAuthoritativeTaskState({ task: state().task })).toBe(false);
  });
});
