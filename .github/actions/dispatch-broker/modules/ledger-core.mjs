/**
 * The ledger primitives every controller module needs: the canonical TaskRef
 * check, the structural validator, and the mutation wrapper that keeps
 * `revision`/`updatedAt` and re-validation together.
 *
 * These live here rather than in `broker.mjs` for one reason: without it,
 * `broker.mjs` imports `modules/intent.mjs` and `modules/scheduler.mjs` while
 * both import `ACTIVE_STATES`/`mutate`/`validateLedger` back out of
 * `broker.mjs` — a genuine ESM cycle.
 *
 * That cycle happens to work today, which is exactly what makes it worth
 * removing. It survives only because nothing in either module reads an
 * imported binding at module-evaluation time; every use is inside a function
 * body, by which point the cycle has settled. Add one innocuous top-level
 * `const FOO = new Set([...ACTIVE_STATES])` to either module and it becomes a
 * temporal-dead-zone crash — at import time, in the control plane, dependent
 * on which file the entry point happened to load first. A dependency that
 * only works until someone writes ordinary code is not a dependency worth
 * keeping.
 *
 * Nothing here imports back. `broker.mjs` re-exports these under their
 * historical names, so every existing importer is unaffected.
 */

import {
  LEDGER_ACTIVE_GENERATION_STATES,
  LEDGER_SCHEMA,
} from '../../../../libs/dispatch-contracts/src/index.js';

/**
 * The states in which a generation still has, or is about to have, a live
 * workflow attempt. Aliased rather than re-spelled so the shared contract
 * stays the single definition.
 */
export const ACTIVE_STATES = LEDGER_ACTIVE_GENERATION_STATES;

export function assertTaskRef(task) {
  if (
    !task ||
    !Number.isSafeInteger(task.repositoryId) ||
    task.repositoryId <= 0 ||
    !/^[^/]+\/[^/]+$/u.test(task.repository) ||
    !Number.isSafeInteger(task.issue) ||
    task.issue <= 0
  ) {
    throw new Error('Invalid canonical TaskRef');
  }
}

export function createLedger(task, now = new Date().toISOString()) {
  assertTaskRef(task);
  return {
    schema: LEDGER_SCHEMA,
    revision: 0,
    task: structuredClone(task),
    createdAt: now,
    updatedAt: now,
    control: { closed: false },
    sources: [],
    generations: [],
    anomalies: [],
  };
}

/**
 * The writer's fail-closed gate. Deliberately stricter than the shared
 * package's read-side `isWellFormedLedger`: a writer must refuse anything it
 * cannot trust, where a reader must degrade rather than crash a dashboard.
 */
export function validateLedger(ledger, task) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA) {
    throw new Error('Malformed dispatch ledger: unsupported schema');
  }
  assertTaskRef(ledger.task);
  assertTaskRef(task);
  if (
    ledger.task.repositoryId !== task.repositoryId ||
    ledger.task.repository.toLowerCase() !== task.repository.toLowerCase() ||
    ledger.task.issue !== task.issue
  ) {
    throw new Error('Malformed dispatch ledger: canonical TaskRef mismatch');
  }
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 0) {
    throw new Error('Malformed dispatch ledger: invalid revision');
  }
  if (!Array.isArray(ledger.sources) || !Array.isArray(ledger.generations)) {
    throw new Error('Malformed dispatch ledger: missing history');
  }
  const active = ledger.generations.filter((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
  const pending = ledger.generations.filter(
    (generation) => generation.state === 'pending',
  );
  if (active.length > 1 || pending.length > 1) {
    throw new Error(
      'Malformed dispatch ledger: invalid active/pending cardinality',
    );
  }
  return ledger;
}

/**
 * Every state transition goes through here, so bumping `revision`, stamping
 * `updatedAt`, and re-validating can never be forgotten by one call site.
 */
export function mutate(ledger, now, callback) {
  callback();
  ledger.revision += 1;
  ledger.updatedAt = now;
  validateLedger(ledger, ledger.task);
  return ledger;
}
