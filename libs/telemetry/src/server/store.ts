import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@agent-lcars/util-server';
import {
  Firestore,
  Query,
  type QueryDocumentSnapshot,
  Timestamp,
} from '@google-cloud/firestore';
import { App, getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldPath as AdminFieldPath,
  FieldValue as AdminFieldValue,
  Firestore as AdminFirestore,
  getFirestore as getAdminFirestore,
  Timestamp as AdminTimestamp,
} from 'firebase-admin/firestore';

import {
  canonicalActiveSince,
  parseSessionDoc,
  SESSION_WRITTEN_AT_FIELD,
} from '../lib/session-doc';
import {
  sessionSpendForWrite,
  sessionSpendFromStored,
  type StoredSessionSpendInputs,
  storedTokenUsage,
} from '../lib/session-spend';
import {
  SessionDoc,
  SessionRepository,
  SessionSource,
  SessionWrite,
} from '../lib/types';
import { AGENT_TELEMETRY_DATABASE_ID } from './firestore-client';

export const SESSIONS_COLLECTION = 'sessions';

let cachedApp: App | null = null;
let cachedWriterFirestore: AdminFirestore | null = null;

function getOrCreateApp(): App {
  if (cachedApp) {
    return cachedApp;
  }
  const apps = getApps();
  cachedApp = (apps[0] as App) ?? initializeApp({ projectId: getProjectId() });
  return cachedApp;
}

/**
 * Write-side Firestore client for the `agent-telemetry` database, used only
 * by `upsertSession` (the CLI `agent-telemetry upsert` command / host
 * watchers). Relies on ambient Application Default Credentials — a
 * WIF-impersonated token for runner sessions, or the
 * `AGENT_TELEMETRY_WRITER_KEY_JSON` key file for host watchers (see
 * infra/terraform/main.tf's `telemetry_writer` resources) — never a
 * credential hardcoded in this module. Distinct from
 * `getAgentTelemetryReaderFirestore` in firestore-client.ts, which runs as
 * the console's own runtime identity read-only and cannot use to write.
 */
export function getAgentTelemetryWriterFirestore(): AdminFirestore {
  if (cachedWriterFirestore) {
    return cachedWriterFirestore;
  }

  const app = getOrCreateApp();
  cachedWriterFirestore = getAdminFirestore(app, AGENT_TELEMETRY_DATABASE_ID);

  const emulatorHost = getFirestoreEmulatorHost();
  if (isEmulator() && emulatorHost) {
    cachedWriterFirestore.settings({ host: emulatorHost, ssl: false });
  }

  return cachedWriterFirestore;
}

/**
 * Upserts a session write at `sessions/{sessionId}` in the telemetry
 * database. `expireAt` is written as a Firestore `Timestamp` (not the ISO
 * string `SessionDoc` carries it as) because the collection's TTL policy —
 * see issue #2708 — only recognizes a native Timestamp field.
 *
 * `getAgentTelemetryWriterFirestore` is a `firebase-admin` client, so the
 * `Timestamp` and the `write.clearFields` delete sentinel come from the
 * `firebase-admin/firestore` re-exports (`AdminTimestamp`,
 * `AdminFieldValue`), not from the direct `@google-cloud/firestore` import
 * `listSessionDocs` uses. The SDK validates writes with `instanceof`, so a
 * value must come from the same loaded copy of the package as the client.
 * #2762 ("not a valid Firestore document") hit that for `Timestamp`, and
 * #1257 applied the same rule to `FieldValue`, when Next bundled
 * `@google-cloud/firestore` into server chunks while `firebase-admin` stayed
 * external. The console now externalizes `@google-cloud/firestore` too
 * (apps/console/next.config.js `serverExternalPackages`; `firebase-admin` is
 * on Next's default external list), and both resolve to the same physical
 * package, so the classes are identical today. Taking them from the client's own SDK keeps writes
 * correct regardless of how a consumer bundles the two imports.
 *
 * Takes a {@link SessionWrite}, never a bare `SessionDoc` plus extra
 * arguments — see that type's doc comment in `types.ts` for why a caller
 * cannot describe a write this value doesn't already carry.
 */
export async function upsertSession(write: SessionWrite): Promise<void> {
  const { doc, clearFields } = write;
  const firestore = getAgentTelemetryWriterFirestore();
  const ref = firestore.collection(SESSIONS_COLLECTION).doc(doc.sessionId);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    transaction.set(
      ref,
      {
        ...doc,
        spend: sessionSpendForWrite(write, snapshot.data()),
        ...(doc.expireAt && {
          expireAt: AdminTimestamp.fromDate(new Date(doc.expireAt)),
        }),
        ...Object.fromEntries(
          clearFields.map((field) => [field, AdminFieldValue.delete()]),
        ),
        [SESSION_WRITTEN_AT_FIELD]: AdminFieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

/**
 * Sets or clears only `expireAt` on an existing session doc -- the write a
 * native work item's lifecycle needs, as opposed to `upsertSession`'s full
 * reduce-then-merge write. `expireAt: null` deletes the field, which keeps
 * the doc out of the collection's Firestore TTL policy entirely (an open
 * item's sessions); an ISO string stamps the horizon (a closed item's
 * sessions). Same `AdminTimestamp` conversion `upsertSession` applies, for
 * the reason its doc comment gives.
 *
 * `.update`, not `.set(..., { merge: true })`: a doc that is already gone
 * (TTL-deleted, or never written) must stay gone rather than be resurrected
 * as a field-less ghost. Resolves `false` in that case, `true` otherwise.
 */
export async function setSessionExpiry(
  sessionId: string,
  expireAt: string | null,
): Promise<boolean> {
  const firestore = getAgentTelemetryWriterFirestore();
  try {
    await firestore
      .collection(SESSIONS_COLLECTION)
      .doc(sessionId)
      .update({
        expireAt:
          expireAt === null
            ? AdminFieldValue.delete()
            : AdminTimestamp.fromDate(new Date(expireAt)),
        [SESSION_WRITTEN_AT_FIELD]: AdminFieldValue.serverTimestamp(),
      });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Session ids of every doc tagged with one of `intentIds` (the orchestrator
 * run ids of one work item), read through the writer client. Unlike the
 * console's read path, which degrades to an empty list, this propagates any
 * read failure: the session-expiry workflow must fail loudly rather than
 * succeed having touched nothing.
 */
export async function sessionIdsForIntents(
  intentIds: readonly string[],
): Promise<string[]> {
  const firestore = getAgentTelemetryWriterFirestore();
  const perIntent = await Promise.all(
    intentIds.map((intentId) =>
      firestore
        .collection(SESSIONS_COLLECTION)
        .where('intentId', '==', intentId)
        .select()
        .get(),
    ),
  );
  return perIntent.flatMap((snapshot) => snapshot.docs.map((doc) => doc.id));
}

/** gRPC NOT_FOUND (5), as the Firestore SDKs report a missing doc. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 5
  );
}

/** Largest page one spend-backfill call reads. Well under Firestore's 500
 * documents-per-batch bound, and each stale doc is written in its own
 * transaction, so a smaller page also bounds the work between progress lines. */
const MAX_SPEND_BACKFILL_PAGE_SIZE = 200;

/** The fields a spend-backfill page reads: the four pricing inputs
 * `spend` is derived from, the stored `spend` it is compared against, and the
 * activity time that decides whether the doc is in the window. */
const SPEND_BACKFILL_FIELDS = [
  'lastActivityAt',
  'tokens',
  'model',
  'resolvedModel',
  'totalCostUsd',
  'spend',
];

export interface BackfillSessionSpendOptions {
  /** Write what the pass derives. Without it the pass only reports coverage,
   * which is the read an operator uses to decide the totals cutover is safe. */
  apply: boolean;
  /** The `nextCursor` of a previous page; the resumable position. */
  cursor?: string;
  /** Sessions last active before it are counted as `outsideWindow` and left
   * untouched: no page reads them, so materializing their spend buys nothing.
   * Any parseable instant is accepted and canonicalized to UTC milliseconds —
   * see {@link canonicalActiveSince}. Defaults to no window (the whole
   * collection). */
  activeSince?: string;
  /** Docs per page, clamped to [1, {@link MAX_SPEND_BACKFILL_PAGE_SIZE}]. */
  pageSize?: number;
}

export interface BackfillSessionSpendPage {
  /** Docs this page read. */
  scanned: number;
  /** Docs whose stored `spend` is missing or disagrees with their pricing inputs. */
  stale: number;
  /** Docs this page actually wrote (`apply` only, and only if still stale in
   * the write transaction). */
  written: number;
  /** In-window docs whose stored fields cannot yield a spend — no complete
   * `tokens` map. Left untouched; a nonzero count means a writer is not
   * recording usage, not a backfill to retry. Those sessions are absent from an
   * indexed total rather than wrong in it, so this counter has to be zero (or
   * reconciled) before the totals cutover, alongside `stale`. */
  unusable: number;
  scannedOutsideWindow: number;
  /** Pass back as `cursor` to resume; absent once a page came back short. */
  nextCursor?: string;
}

/**
 * Brings stored session docs up to the materialized-`spend` contract that
 * #3641's writers now maintain, walking the `sessions` collection in document
 * id order and re-deriving each doc's `spend` from its own pricing inputs
 * through {@link sessionSpendFromStored} — the same derivation the writers use,
 * so a backfilled doc and a written one cannot disagree.
 *
 * It is resumable (`cursor` is a document id, `nextCursor` is the next
 * position), idempotent (a doc whose stored `spend` already matches is not
 * written, so a second pass costs reads only), and dry-run by default.
 * Ordering by document id is what keeps it index-free: a `lastActivityAt` range
 * plus that ordering would need a new composite index, so the window is applied
 * per doc instead of in the query.
 *
 * Each write re-reads the doc in its own transaction and re-derives, because a
 * live writer may have advanced the session between this page's read and its
 * write; overwriting that with the older value would silently under-report a
 * running session. The transaction's read is also what makes a concurrent write
 * abort this one rather than race it.
 *
 * Run it again after a writer rollout reaches every runner image: a session
 * still being updated by an older writer is stale again the moment it is
 * written, which is why the operator's acceptance is a dry run reporting
 * `stale: 0`, not one pass of `--apply`. And `stale: 0` alone is not coverage:
 * in-window `unusable` docs are sessions no writer priced at all, which an
 * indexed total silently counts as free, so the cutover gate is both counters at
 * zero (or their contribution reconciled against the ledger by hand).
 */
export async function backfillSessionSpend(
  options: BackfillSessionSpendOptions,
): Promise<BackfillSessionSpendPage> {
  const firestore = getAgentTelemetryWriterFirestore();
  // One canonical instant for both the page filter and the re-check inside each
  // write transaction, so the two can never disagree about the cutoff.
  const activeSince =
    options.activeSince === undefined
      ? undefined
      : canonicalActiveSince(options.activeSince);
  const pageSize = Math.min(
    Math.max(1, options.pageSize ?? MAX_SPEND_BACKFILL_PAGE_SIZE),
    MAX_SPEND_BACKFILL_PAGE_SIZE,
  );
  const query = firestore
    .collection(SESSIONS_COLLECTION)
    .orderBy(AdminFieldPath.documentId())
    .select(...SPEND_BACKFILL_FIELDS);
  const page = await (
    options.cursor === undefined ? query : query.startAfter(options.cursor)
  )
    .limit(pageSize)
    .get();

  let stale = 0;
  let written = 0;
  let unusable = 0;
  let scannedOutsideWindow = 0;
  for (const doc of page.docs) {
    const stored = doc.data();
    if (isOutsideWindow(stored, activeSince)) {
      scannedOutsideWindow += 1;
      continue;
    }
    const derived = sessionSpendFromStored(spendInputsFromStored(stored));
    if (derived === undefined) {
      unusable += 1;
      continue;
    }
    if (sameSpend(stored['spend'], derived)) {
      continue;
    }
    stale += 1;
    if (!options.apply) {
      continue;
    }
    const ref = doc.ref;
    const changed = await firestore.runTransaction(async (transaction) => {
      const currentData = (await transaction.get(ref)).data();
      if (currentData === undefined) {
        // TTL-deleted or removed since the page read: nothing to bring up.
        return false;
      }
      if (isOutsideWindow(currentData, activeSince)) {
        // A live writer can move `lastActivityAt` back across the cutoff
        // between the page read and this transaction, which puts the doc outside
        // the window the operator asked for. It is not this pass's to write.
        return false;
      }
      const currentDerived = sessionSpendFromStored(
        spendInputsFromStored(currentData),
      );
      if (
        currentDerived === undefined ||
        sameSpend(currentData['spend'], currentDerived)
      ) {
        return false;
      }
      transaction.update(ref, {
        spend: currentDerived,
        [SESSION_WRITTEN_AT_FIELD]: AdminFieldValue.serverTimestamp(),
      });
      return true;
    });
    if (changed) {
      written += 1;
    }
  }

  const nextCursor = page.size === pageSize ? page.docs.at(-1)?.id : undefined;
  return {
    scanned: page.size,
    stale,
    written,
    unusable,
    scannedOutsideWindow,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function isOutsideWindow(
  stored: Record<string, unknown> | undefined,
  activeSince: string | undefined,
): boolean {
  if (activeSince === undefined) {
    return false;
  }
  // `lastActivityAt` is stored as an ISO 8601 UTC string (see listSessionDocs),
  // so the lexicographic comparison is the time comparison.
  const lastActivityAt = stored?.['lastActivityAt'];
  return typeof lastActivityAt !== 'string' || lastActivityAt < activeSince;
}

function spendInputsFromStored(
  stored: Record<string, unknown> | undefined,
): StoredSessionSpendInputs {
  const model = stored?.['model'];
  const resolvedModel = stored?.['resolvedModel'];
  const totalCostUsd = stored?.['totalCostUsd'];
  return {
    tokens: storedTokenUsage(stored?.['tokens']),
    model: typeof model === 'string' ? model : undefined,
    resolvedModel:
      typeof resolvedModel === 'string' ? resolvedModel : undefined,
    totalCostUsd:
      typeof totalCostUsd === 'number' && Number.isFinite(totalCostUsd)
        ? totalCostUsd
        : undefined,
  };
}

/** Whether a stored `spend` already holds the derived value. Anything that is
 * not the two-number shape a writer produces counts as missing, so a malformed
 * field is repaired rather than treated as coverage. */
function sameSpend(
  stored: unknown,
  derived: NonNullable<SessionDoc['spend']>,
): boolean {
  if (typeof stored !== 'object' || stored === null) {
    return false;
  }
  const { tokens, costUsd } = stored as Record<string, unknown>;
  return tokens === derived.tokens && costUsd === derived.costUsd;
}

/** Default retained result size for dashboard and scoped session readers.
 * Archive consumers explicitly opt into exhaustive streamed results. */
const DEFAULT_LIST_LIMIT = 100;
/** Maximum retained result size for bounded readers. Exhaustive archive
 * reads retain all matches in their selected time window instead. */
export const MAX_LIST_LIMIT = 200;

export interface ListSessionDocsOptions {
  /** Only return sessions with `lastActivityAt` at or after this ISO
   * timestamp. Without it the listing is unbounded - the collection grows
   * by one doc per session forever (200+ within the first weeks of
   * rollout) - so every recurring reader should pass a cutoff. */
  activeSince?: string;
  /** Narrows to one source. Combined with `activeSince` this is a
   * range+equality compound query, requiring a source+lastActivityAt
   * composite index on `sessions`. */
  source?: SessionSource;
  /** Narrows to one repository through the persisted canonical
   * `repo.owner`/`repo.name` map fields (exact match: the writer stores the
   * canonical spelling). Combined with `source` and `activeSince` it needs
   * the source+repo.owner+repo.name+lastActivityAt composite index
   * (`sessions_source_repo_last_activity` in infra/terraform/main.tf). */
  repo?: SessionRepository;
  /** Narrows to one issue-agent session's issue. Combined with
   * `activeSince` this is also a compound query - see the
   * issueNumber+lastActivityAt (and source+issueNumber+lastActivityAt)
   * composite indexes alongside the `source` ones. */
  issueNumber?: number;
  /** Narrows to the sessions of one orchestrator run
   * (`IssueAgentSessionDoc.intentId` -- the join key from a native work
   * item's run to its telemetry). Equality-only, so it composes with
   * `source` without a composite index; add `activeSince` and it becomes a
   * compound query needing an intentId+lastActivityAt index, which is why
   * the work API's session join deliberately passes no cutoff -- a run's
   * session set is bounded by the run itself. */
  intentId?: string;
  /** Caps the number of docs returned (post-sort, newest activity first).
   * Clamped to [1, {@link MAX_LIST_LIMIT}]; defaults to
   * {@link DEFAULT_LIST_LIMIT} when omitted. */
  limit?: number;
  /** Retain every matching session for archive rows and aggregate totals.
   * The query is still streamed, with SDK backpressure; callers should supply
   * activeSince to bound the time window. Overrides limit. */
  exhaustive?: boolean;
}

/** A stored session document as a {@link SessionDoc}: the native `expireAt`
 * Timestamp becomes the ISO string the type carries, and the
 * `writtenAt` storage stamp is dropped. */
function sessionFromStored(stored: Record<string, unknown>): SessionDoc {
  const { [SESSION_WRITTEN_AT_FIELD]: _writtenAt, ...data } = stored;
  const expireAt = data['expireAt'];
  return parseSessionDoc({
    ...data,
    ...(expireAt instanceof Timestamp && {
      expireAt: expireAt.toDate().toISOString(),
    }),
  });
}

function readSessionSnapshot(snapshot: QueryDocumentSnapshot): SessionDoc {
  return sessionFromStored(snapshot.data());
}

/** Session documents written at or after `since`, with the time the read
 * observed. Every commit at or before `readTime` is reflected, so passing
 * it back as the next `since` misses no write. Served by the automatic
 * single-field `writtenAt` index. */
export async function listSessionDocsWrittenSince(
  firestore: Firestore,
  since: Timestamp,
): Promise<{ docs: SessionDoc[]; readTime: Timestamp }> {
  const snapshot = await firestore
    .collection(SESSIONS_COLLECTION)
    .where(SESSION_WRITTEN_AT_FIELD, '>=', since)
    .get();
  return {
    docs: snapshot.docs.map(readSessionSnapshot),
    readTime: snapshot.readTime,
  };
}

/** Firestore's maximum number of values in one `in` filter. */
const IN_FILTER_MAX = 30;

/**
 * The session docs of the given runs (`IssueAgentSessionDoc.runId`), read by
 * key. A page joins telemetry to the few dozen runs it renders; listing the
 * activity window instead reads every session in it (hundreds a day). The
 * automatic single-field `runId` index serves the `in` filter, so this needs
 * no composite index. A run can hold several sessions (one per provider
 * session, including subagents); every one is returned.
 */
export async function listSessionDocsByRunIds(
  firestore: Firestore,
  runIds: Iterable<string>,
): Promise<SessionDoc[]> {
  const unique = [...new Set(runIds)];
  const chunks: string[][] = [];
  for (let start = 0; start < unique.length; start += IN_FILTER_MAX) {
    chunks.push(unique.slice(start, start + IN_FILTER_MAX));
  }
  const collection = firestore.collection(SESSIONS_COLLECTION);
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const docs: SessionDoc[] = [];
      const snapshots = collection
        .where('runId', 'in', chunk)
        .stream() as unknown as AsyncIterable<QueryDocumentSnapshot>;
      for await (const snapshot of snapshots) {
        docs.push(readSessionSnapshot(snapshot));
      }
      return docs;
    }),
  );
  return pages.flat();
}

/**
 * Lists session docs in the `agent-telemetry` database, newest activity
 * first. Read-only by design (the console's SA cannot write - see
 * firestore-client.ts); callers narrow by `liveness` themselves (not a
 * stored/queryable field in the sense that matters here - see
 * `displayLiveness`, which recomputes it at read time).
 */
export async function listSessionDocs(
  firestore: Firestore,
  options: ListSessionDocsOptions = {},
): Promise<SessionDoc[]> {
  const collection = firestore.collection(SESSIONS_COLLECTION);
  // ISO 8601 UTC timestamps compare correctly as strings, so the
  // activeSince range filter works without a Timestamp field. source/
  // issueNumber/intentId are plain equality filters; composing any of them
  // with the range filter needs the composite indexes documented above.
  let query: Query = collection;
  if (options.activeSince) {
    query = query.where(
      'lastActivityAt',
      '>=',
      canonicalActiveSince(options.activeSince),
    );
  }
  if (options.source) {
    query = query.where('source', '==', options.source);
  }
  if (options.repo !== undefined) {
    query = query
      .where('repo.owner', '==', options.repo.owner)
      .where('repo.name', '==', options.repo.name);
  }
  if (options.issueNumber !== undefined) {
    query = query.where('issueNumber', '==', options.issueNumber);
  }
  if (options.intentId !== undefined) {
    query = query.where('intentId', '==', options.intentId);
  }
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  const docs: SessionDoc[] = [];
  // Keep the existing query and indexes: taking the newest page with a new
  // orderBy would require new composite indexes for scoped session joins.
  // The SDK streams QueryDocumentSnapshots, despite its generic Node stream
  // iterator type. Backpressure avoids retaining an all-document snapshot.
  const snapshots =
    query.stream() as unknown as AsyncIterable<QueryDocumentSnapshot>;
  for await (const snapshot of snapshots) {
    const doc = readSessionSnapshot(snapshot);
    if (options.exhaustive) {
      docs.push(doc);
      continue;
    }
    // Stable descending insertion keeps at most the requested page. Equal
    // activity clocks retain query order, matching the previous stable sort.
    let low = 0;
    let high = docs.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (docs[middle]!.lastActivityAt.localeCompare(doc.lastActivityAt) >= 0)
        low = middle + 1;
      else high = middle;
    }
    if (low < limit) {
      docs.splice(low, 0, doc);
      if (docs.length > limit) docs.pop();
    }
  }
  if (options.exhaustive)
    docs.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return docs;
}

/**
 * Fetches a single session doc by id, or `undefined` if it doesn't exist
 * (never throws for a missing doc - only for a real Firestore failure, left
 * to the caller). Powers the /sessions/[id] detail page.
 */
export async function getSessionDoc(
  firestore: Firestore,
  sessionId: string,
): Promise<SessionDoc | undefined> {
  const snapshot = await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(sessionId)
    .get();
  if (!snapshot.exists) {
    return undefined;
  }
  const data = snapshot.data();
  if (!data) {
    return undefined;
  }
  return sessionFromStored(data);
}

/** @internal Reset cached clients for testing only. */
export function _resetForTesting(): void {
  cachedApp = null;
  cachedWriterFirestore = null;
}
