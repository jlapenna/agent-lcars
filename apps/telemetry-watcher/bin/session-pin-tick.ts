#!/usr/bin/env -S pnpm exec tsx
// apps/telemetry-watcher/bin/session-pin-tick.ts
//
// Sub-project 6's reaper. Lists every open (running/parked) native item,
// paging the read-only work API's `list` route to cover the whole fleet
// history rather than just its newest page (issue #1546), via the
// read-only work API (a GitHub-Actions-OIDC bearer, work.reaper scope --
// see work-auth.ts) and rewrites `expireAt` forward on every session those
// items carry, via telemetry_writer's own Firestore write access
// (WIF-impersonated by the calling workflow). Run by
// work-session-pin-tick.yml, not baked into the runner image -- this is a
// repo-level CI script, invoked with `pnpm exec tsx`, not part of
// sidecar.cjs's bundle (which has its own separate Firestore client,
// create-store.ts, keyed off AGENT_TELEMETRY_PROJECT_ID -- this script goes
// through the console's own @agent-lcars/telemetry/server store instead,
// the same one `touchSessionExpiry`'s only other caller, work-router.ts,
// implicitly relies on via the API it reads).
import { touchSessionExpiry } from '@agent-lcars/telemetry/server';

/** Matches libs/telemetry/src/lib/session-doc.ts's
 *  ISSUE_AGENT_SESSION_RETENTION_DAYS -- kept as a local literal rather
 *  than importing that module (server-only, Next-specific bundling
 *  concerns this standalone script does not need); if that retention
 *  value ever changes, this constant must change with it. Flagged in the
 *  self-review as a manually-synced value, not a shared import. */
const RETENTION_DAYS = 365;

interface ItemSessionLike {
  sessionId: string;
}
interface ItemLike {
  id: string;
  sessions: ItemSessionLike[];
}
interface ItemsResponse {
  items: ItemLike[];
  /** Present iff more native tasks may exist behind this page -- see
   *  `itemsContract.list`'s doc comment. Absent means this state's sweep
   *  is exhausted, regardless of whether this particular page came back
   *  with any items in it (the state filter is applied per-page, after
   *  the underlying store read). */
  nextCursor?: string;
}

/** Safety valve, not an expected ceiling: real fleet history is nowhere
 *  near `PAGE_LIMIT * MAX_PAGES` (=100,000) native items, so hitting this
 *  means the API is misbehaving -- e.g. always answering a `nextCursor`
 *  regardless of progress -- not that the fleet grew. Bounds the sweep to
 *  a fixed number of requests per state rather than an unbounded scan,
 *  and fails loudly (the whole point of this reaper) instead of looping
 *  forever. */
export const MAX_PAGES = 500;
const PAGE_LIMIT = 200;

export interface PinOpenItemSessionsDeps {
  bearer: string;
  consoleUrl?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  touchExpiry?: typeof touchSessionExpiry;
}

export async function pinOpenItemSessions(
  deps: PinOpenItemSessionsDeps,
): Promise<{ pinned: string[] }> {
  const consoleUrl = deps.consoleUrl ?? 'https://lcars.jlapenna.net';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const touchExpiry = deps.touchExpiry ?? touchSessionExpiry;
  const now = deps.now ?? new Date();
  const expireAt = new Date(
    now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const pinned: string[] = [];
  for (const state of ['running', 'parked'] as const) {
    // Pages until the API stops offering a `nextCursor` -- that, not a
    // single `limit=200` read, is what covers every open item regardless
    // of how many native items the fleet has created in total. (Issue
    // #1546: `limit=200` alone reads as "the 200 open items", but
    // `work-router.ts`'s `list` handler filters by state AFTER reading
    // only the 200 newest native items overall, so a single unpaginated
    // read silently drops any open item older than that.) `MAX_PAGES`
    // bounds this loop even if the API keeps answering a cursor forever --
    // see its own comment.
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${consoleUrl}/api/work/v1/items`);
      url.searchParams.set('state', state);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);
      const response = await fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${deps.bearer}` },
      });
      if (!response.ok) {
        throw new Error(`GET /items?state=${state} -> ${response.status}`);
      }
      const body = (await response.json()) as ItemsResponse;
      for (const item of body.items) {
        for (const session of item.sessions) {
          await touchExpiry(session.sessionId, expireAt);
          pinned.push(session.sessionId);
        }
      }
      if (body.nextCursor === undefined) break;
      cursor = body.nextCursor;
      if (page === MAX_PAGES - 1) {
        throw new Error(
          `GET /items?state=${state} kept returning nextCursor past ` +
            `${MAX_PAGES} pages -- aborting rather than scanning forever`,
        );
      }
    }
  }
  return { pinned };
}

async function main(): Promise<void> {
  const bearer = process.env['SESSION_PIN_TICK_BEARER'];
  if (!bearer) {
    console.error('SESSION_PIN_TICK_BEARER is required');
    process.exit(1);
  }
  const { pinned } = await pinOpenItemSessions({
    bearer,
    ...(process.env['AGENT_LCARS_CONSOLE_URL'] && {
      consoleUrl: process.env['AGENT_LCARS_CONSOLE_URL'],
    }),
  });
  console.log(
    `pinned ${pinned.length} session(s): ${pinned.join(', ') || '(none)'}`,
  );
}

// tsx-executed entrypoint guard, standard Node CommonJS idiom -- this file
// has no package.json "type": "module" above it (repo root's package.json
// has none), so tsx runs it as CommonJS and `require`/`module` are real.
// main.ts (this app's bundled sidecar entrypoint) instead guards on
// `process.env.VITEST` because *that* file's tsconfig.app.json pins
// `module: "commonjs"` for its emitted declarations while its runtime is a
// bundled esbuild CJS artifact -- `import.meta` is a syntax error there
// under `nx typecheck` even though the runtime tolerates it. This script
// has no such split (typechecked and executed the same way, as plain
// CommonJS via tsx), so the ordinary `require.main === module` guard
// applies directly -- false under vitest (vite-node's module wrapper is
// never require.main), true when tsx runs this file as the process
// entrypoint. Mirrors main.ts's own module-vs-import discipline: this file
// is imported directly by session-pin-tick.spec.ts without running main().
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
