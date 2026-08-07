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

import type {
  DispatchLedger,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import {
  LEDGER_ACTIVE_GENERATION_STATES,
  LEDGER_SCHEMA,
} from '@agent-lcars/dispatch-contracts';

/**
 * The states in which a generation still has, or is about to have, a live
 * workflow attempt. Aliased rather than re-spelled so the shared contract
 * stays the single definition.
 */
export const ACTIVE_STATES = LEDGER_ACTIVE_GENERATION_STATES;

/**
 * `task` is `unknown` on purpose: this function's whole job is standing
 * between a value nothing has vetted yet (a freshly-parsed ledger comment, a
 * caller-supplied TaskRef) and the rest of the controller, which is allowed
 * to assume `LedgerTaskRef` once this returns without throwing.
 */
export function assertTaskRef(task: unknown): asserts task is LedgerTaskRef {
  // Narrowing cast, not a trust decision: every field below is validated
  // before anything downstream is allowed to rely on it, exactly what
  // `asserts task is LedgerTaskRef` documents.
  const candidate = task as Partial<LedgerTaskRef> | null | undefined;
  if (
    !candidate ||
    !Number.isSafeInteger(candidate.repositoryId) ||
    (candidate.repositoryId as number) <= 0 ||
    // .test() coerces a non-string argument via ToString same as this cast
    // would -- the cast changes no behavior, it only satisfies the compiler.
    !/^[^/]+\/[^/]+$/u.test(candidate.repository as string) ||
    !Number.isSafeInteger(candidate.issue) ||
    (candidate.issue as number) <= 0
  ) {
    throw new Error('Invalid canonical TaskRef');
  }
}

export function createLedger(
  task: LedgerTaskRef,
  now: string = new Date().toISOString(),
): DispatchLedger {
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
 *
 * `ledger` is `unknown`: callers pass both a runtime-constructed
 * `DispatchLedger` (trivially valid) and the result of parsing a ledger
 * comment straight off GitHub (`extraction.ledger`, genuinely untrusted) --
 * see broker.mjs's `loadLedger`.
 */
export function validateLedger(
  ledger: unknown,
  task: LedgerTaskRef,
): DispatchLedger {
  // Same narrowing posture as assertTaskRef: nothing here is trusted until
  // the specific check for it below has passed.
  const candidate = ledger as Partial<DispatchLedger> | null | undefined;
  if (!candidate || candidate.schema !== LEDGER_SCHEMA) {
    throw new Error('Malformed dispatch ledger: unsupported schema');
  }
  assertTaskRef(candidate.task);
  assertTaskRef(task);
  if (
    candidate.task.repositoryId !== task.repositoryId ||
    candidate.task.repository.toLowerCase() !== task.repository.toLowerCase() ||
    candidate.task.issue !== task.issue
  ) {
    throw new Error('Malformed dispatch ledger: canonical TaskRef mismatch');
  }
  if (
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    throw new Error('Malformed dispatch ledger: invalid revision');
  }
  if (
    !Array.isArray(candidate.sources) ||
    !Array.isArray(candidate.generations)
  ) {
    throw new Error('Malformed dispatch ledger: missing history');
  }
  const active = candidate.generations.filter((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
  const pending = candidate.generations.filter(
    (generation) => generation.state === 'pending',
  );
  if (active.length > 1 || pending.length > 1) {
    throw new Error(
      'Malformed dispatch ledger: invalid active/pending cardinality',
    );
  }
  // `createdAt`/`updatedAt`/`anomalies` are unchecked above exactly as they
  // always were -- this cast documents that the shape is trusted from here
  // on, not that it was fully verified.
  return candidate as DispatchLedger;
}

/**
 * Every state transition goes through here, so bumping `revision`, stamping
 * `updatedAt`, and re-validating can never be forgotten by one call site.
 */
export function mutate(
  ledger: DispatchLedger,
  now: string,
  callback: () => void,
): DispatchLedger {
  callback();
  ledger.revision += 1;
  ledger.updatedAt = now;
  validateLedger(ledger, ledger.task);
  return ledger;
}
