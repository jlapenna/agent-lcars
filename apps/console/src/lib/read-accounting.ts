import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '@agent-lcars/logging';
import {
  DocumentReference,
  Firestore,
  Query,
  Transaction,
} from '@google-cloud/firestore';

/**
 * Counts the Firestore documents this server reads, by the orchestrator
 * store method that read them (when one did) and by collection, and logs
 * the totals every five minutes:
 *
 *   agent-lcars: firestore read accounting {"windowMinutes":5,
 *     "reads":{"listNativeTasks orchestrator-tasks":{"calls":40,"docs":17440}}}
 *
 * The dispatch database alone served about 3 million document reads a day
 * on 2026-11-25, far more than page loads explain; this attributes them.
 * The wrappers only observe results. Streamed queries and listeners are not
 * counted: observing a stream would change how it is consumed.
 *
 * Query in Cloud Logging with `textPayload:"firestore read accounting"`.
 */

const REPORT_INTERVAL_MS = 5 * 60_000;
const TOP_LABELS = 25;
const INSTALLED_KEY = '__agentLcarsFirestoreReadAccounting';

const operation = new AsyncLocalStorage<string>();
const counts = new Map<string, { calls: number; docs: number }>();

/** Runs `read` with `label` naming the operation its Firestore reads belong to. */
export function withReadLabel<T>(label: string, read: () => T): T {
  return operation.getStore() === undefined
    ? operation.run(label, read)
    : read();
}

function collectionOf(target: unknown): string {
  if (target instanceof DocumentReference) return target.parent.id;
  const options = (target as { _queryOptions?: { collectionId?: string } })
    ._queryOptions;
  return options?.collectionId ?? 'unknown';
}

function docCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const docs = (result as { docs?: unknown } | undefined)?.docs;
  if (Array.isArray(docs)) return docs.length;
  return result === undefined ? 0 : 1;
}

export function recordRead(collection: string, docs: number): void {
  const label = `${operation.getStore() ?? 'direct'} ${collection}`;
  const entry = counts.get(label) ?? { calls: 0, docs: 0 };
  entry.calls += 1;
  entry.docs += docs;
  counts.set(label, entry);
}

function observe<A extends unknown[], R>(
  original: (...args: A) => Promise<R>,
  collection: (self: unknown, args: A) => string,
) {
  return function (this: unknown, ...args: A): Promise<R> {
    const pending = original.apply(this, args);
    const name = collection(this, args);
    void pending.then(
      (result) => recordRead(name, docCount(result)),
      () => undefined,
    );
    return pending;
  };
}

export function report(): void {
  if (counts.size === 0) return;
  const reads = Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => b[1].docs - a[1].docs)
      .slice(0, TOP_LABELS),
  );
  const totalDocs = [...counts.values()].reduce((sum, c) => sum + c.docs, 0);
  counts.clear();
  logger.info('agent-lcars: firestore read accounting', {
    windowMinutes: REPORT_INTERVAL_MS / 60_000,
    totalDocs,
    reads,
  });
}

/** Wraps the SDK's read methods once per process. */
export function installReadAccounting(): void {
  const realm = globalThis as Record<string, unknown>;
  if (realm[INSTALLED_KEY]) return;
  realm[INSTALLED_KEY] = true;

  Query.prototype.get = observe(Query.prototype.get, (self) =>
    collectionOf(self),
  );
  // DocumentReference.get is not wrapped: it reads through Firestore.getAll,
  // which is, so wrapping both would count each document twice.
  Firestore.prototype.getAll = observe(
    Firestore.prototype.getAll,
    (_self, refs) => collectionOf(refs[0]),
  ) as typeof Firestore.prototype.getAll;
  Transaction.prototype.get = observe(
    Transaction.prototype.get as (ref: unknown) => Promise<unknown>,
    (_self, [ref]) => collectionOf(ref),
  ) as typeof Transaction.prototype.get;
  Transaction.prototype.getAll = observe(
    Transaction.prototype.getAll,
    (_self, refs) => collectionOf(refs[0]),
  ) as typeof Transaction.prototype.getAll;

  setInterval(report, REPORT_INTERVAL_MS).unref();
}

/** The orchestrator store with each method's reads labelled by its name. */
export function labelStoreReads<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property !== 'string')
        return value;
      return (...args: unknown[]) =>
        withReadLabel(property, () => value.apply(target, args));
    },
  });
}
