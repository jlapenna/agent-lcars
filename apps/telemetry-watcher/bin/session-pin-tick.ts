#!/usr/bin/env -S pnpm exec tsx
// apps/telemetry-watcher/bin/session-pin-tick.ts
//
// Sub-project 6's reaper. Lists every open (running/parked) native item via
// the read-only work API (a GitHub-Actions-OIDC bearer, work.reaper scope --
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
}

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
    const response = await fetchImpl(
      `${consoleUrl}/api/work/v1/items?state=${state}&limit=200`,
      { headers: { authorization: `Bearer ${deps.bearer}` } },
    );
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
