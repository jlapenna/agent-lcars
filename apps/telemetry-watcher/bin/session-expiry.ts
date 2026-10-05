#!/usr/bin/env -S pnpm exec tsx
// apps/telemetry-watcher/bin/session-expiry.ts
//
// Makes a native work item's session docs match the item's lifecycle: an
// open (running/parked) item's sessions carry no `expireAt`, so the
// `sessions` collection's Firestore TTL policy never reaps them; a closed
// (done/failed/canceled) item's sessions expire
// ISSUE_AGENT_SESSION_RETENTION_DAYS after the close. The telemetry sidecar
// already omits `expireAt` while it writes a native session
// (`isNativeWorkSessionWrite`); this script applies the close.
//
// Run by work-session-expiry.yml, which the console dispatches when an item
// closes (`dispatchSessionExpiry`). Reads go through the read-only work API
// with a GitHub-Actions-OIDC bearer (work.reaper scope, see work-auth.ts);
// writes use telemetry_writer's Firestore access, WIF-impersonated by the
// workflow. Neither identity alone can do both, which is why this hop
// exists. Without an item it clears `expireAt` on every open item's
// sessions: the one-time migration of sessions the retired 30-minute pin
// tick had stamped, and a manual backstop.
import {
  sessionIdsForIntents,
  setSessionExpiry,
} from '@agent-lcars/telemetry/server';

/** Matches libs/telemetry/src/lib/session-doc.ts's
 *  ISSUE_AGENT_SESSION_RETENTION_DAYS (asserted by session-expiry.spec.ts)
 *  -- a local literal so this standalone tsx script does not import the
 *  Next-bundled telemetry lib entry point. */
const RETENTION_DAYS = 365;

type ItemState = 'running' | 'done' | 'parked' | 'failed' | 'canceled';
const OPEN_STATES: readonly ItemState[] = ['running', 'parked'];

interface ItemLike {
  id: string;
  state: ItemState;
  runs: { runId: string }[];
}
interface ItemsResponse {
  items: ItemLike[];
  /** Present iff more native tasks may exist behind this page -- see
   *  `itemsContract.list`'s doc comment. */
  nextCursor?: string;
}

/** Bound on pages per state, plus one exhaustion probe (see the loop). Real
 *  native history is nowhere near PAGE_LIMIT * MAX_PAGES items, so a cursor
 *  still standing after that means the API is misbehaving. */
export const MAX_PAGES = 500;
const PAGE_LIMIT = 200;

export interface SessionExpiryDeps {
  bearer: string;
  consoleUrl?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  setExpiry?: typeof setSessionExpiry;
  /** Session lookup by run id. Read directly (as telemetry_writer) rather
   *  than from the item's `sessions`, which the Work API degrades to an
   *  empty list when its telemetry read fails. */
  sessionIds?: typeof sessionIdsForIntents;
}

export interface ItemExpiryResult {
  itemId: string;
  state: ItemState;
  /** `expireAt` written to every session, or null when cleared. */
  expireAt: string | null;
  sessions: string[];
}

function resolve(deps: SessionExpiryDeps) {
  return {
    consoleUrl: deps.consoleUrl ?? 'https://lcars.jlapenna.net',
    fetchImpl: deps.fetchImpl ?? fetch,
    setExpiry: deps.setExpiry ?? setSessionExpiry,
    sessionIds: deps.sessionIds ?? sessionIdsForIntents,
    now: deps.now ?? new Date(),
    headers: { authorization: `Bearer ${deps.bearer}` },
  };
}

async function applyExpiry(
  setExpiry: typeof setSessionExpiry,
  sessions: readonly string[],
  expireAt: string | null,
): Promise<string[]> {
  const applied: string[] = [];
  for (const sessionId of sessions) {
    if (await setExpiry(sessionId, expireAt)) applied.push(sessionId);
  }
  return applied;
}

/**
 * Reads one item and applies its current lifecycle to its sessions. It
 * reads state at run time rather than trusting the dispatch, so a dispatch
 * that arrives after the item reopened clears instead of stamping.
 */
export async function settleItemSessionExpiry(
  itemId: string,
  deps: SessionExpiryDeps,
): Promise<ItemExpiryResult> {
  const { consoleUrl, fetchImpl, setExpiry, sessionIds, now, headers } =
    resolve(deps);
  const response = await fetchImpl(
    `${consoleUrl}/api/work/v1/items/${encodeURIComponent(itemId)}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`GET /items/${itemId} -> ${response.status}`);
  }
  const item = (await response.json()) as ItemLike;
  const expireAt = OPEN_STATES.includes(item.state)
    ? null
    : new Date(
        now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
  const sessions = await applyExpiry(
    setExpiry,
    await sessionIds(item.runs.map((run) => run.runId)),
    expireAt,
  );
  return { itemId, state: item.state, expireAt, sessions };
}

/**
 * Clears `expireAt` on every session of every open item, paging each state
 * until the API stops offering a cursor. Both states are always attempted;
 * failures are reported together afterwards.
 */
export async function clearOpenItemSessionExpiry(
  deps: SessionExpiryDeps,
): Promise<{ cleared: string[] }> {
  const { consoleUrl, fetchImpl, setExpiry, sessionIds, headers } =
    resolve(deps);
  const cleared: string[] = [];

  async function clearState(state: ItemState): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page <= MAX_PAGES; page += 1) {
      const url = new URL(`${consoleUrl}/api/work/v1/items`);
      url.searchParams.set('state', state);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);
      const response = await fetchImpl(url.toString(), { headers });
      if (!response.ok) {
        throw new Error(`GET /items?state=${state} -> ${response.status}`);
      }
      const body = (await response.json()) as ItemsResponse;
      for (const item of body.items) {
        const ids = await sessionIds(item.runs.map((run) => run.runId));
        cleared.push(...(await applyExpiry(setExpiry, ids, null)));
      }
      if (body.nextCursor === undefined) return;
      cursor = body.nextCursor;
      if (page === MAX_PAGES) {
        throw new Error(
          `GET /items?state=${state} kept returning nextCursor past ` +
            `${MAX_PAGES} pages (plus one exhaustion probe)`,
        );
      }
    }
  }

  const failures: string[] = [];
  for (const state of OPEN_STATES) {
    try {
      await clearState(state);
    } catch (error) {
      failures.push(
        `${state} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `session-expiry sweep failed for ${failures.length}/${OPEN_STATES.length} state(s): ${failures.join('; ')}`,
    );
  }
  return { cleared };
}

async function main(): Promise<void> {
  const bearer = process.env['SESSION_EXPIRY_BEARER'];
  if (!bearer) {
    console.error('SESSION_EXPIRY_BEARER is required');
    process.exit(1);
  }
  const deps: SessionExpiryDeps = {
    bearer,
    ...(process.env['AGENT_LCARS_CONSOLE_URL'] && {
      consoleUrl: process.env['AGENT_LCARS_CONSOLE_URL'],
    }),
  };
  const itemId = process.env['SESSION_EXPIRY_ITEM']?.trim();
  if (itemId) {
    const result = await settleItemSessionExpiry(itemId, deps);
    console.log(
      `item ${result.itemId} is ${result.state}: ` +
        `${result.expireAt === null ? 'cleared expireAt on' : `set expireAt=${result.expireAt} on`} ` +
        `${result.sessions.length} session(s): ${result.sessions.join(', ') || '(none)'}`,
    );
    return;
  }
  const { cleared } = await clearOpenItemSessionExpiry(deps);
  console.log(
    `cleared expireAt on ${cleared.length} open-item session(s): ${cleared.join(', ') || '(none)'}`,
  );
}

// tsx runs this file as CommonJS (no "type": "module" above it), so the
// ordinary entrypoint guard applies; it is false under vitest, which
// imports this module without running main().
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
