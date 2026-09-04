import 'server-only';

import type { ScheduleStore } from '@agent-lcars/orchestrator';
import { optional } from '@agent-lcars/util-server';

import {
  controlPlaneRepository,
  isPushWatchedRepository,
  pushWatchTargetRepo,
} from './deployment';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import {
  grantForPrincipal,
  parseWorkGrants,
  workMaxLiveRuns,
} from './work-grants';
import { mintItem, type WorkContext } from './work-mint';
import {
  sessionDocsForRuns,
  sessionForResume,
  sessionsForRuns,
} from './work-sessions';

type RouteResult = { status: number; body: Record<string, unknown> };

/** The fixed synthetic principal this feature mints work as. Not a bearer
 * identity — the webhook route's HMAC signature verification is this
 * delivery's authentication, mirroring how `admitGithubWork` already skips
 * `grantsPrincipal` entirely for webhook-sourced GitHub-anchor admissions.
 * Its grant still goes through the ordinary `AGENT_LCARS_WORK_GRANTS`
 * pipeline/repo check (`forbiddenReason`), the same as every other minted
 * item — see `docs/deployment-boundary.md`. */
const PUSH_WATCH_PRINCIPAL = 'svc:push-watch';
const PUSH_WATCH_PIPELINE = 'claude';

/** `mintItem` never reads `WorkContext.scheduleStore` — only
 * `schedule-router.ts`'s own tick logic does. Building the real
 * Firestore-backed store (`createScheduleStore()`) here would be both
 * wasted work on every push delivery and an unwanted `PROJECT_ID`
 * dependency this handler otherwise has no reason to need. Every method
 * throws if ever actually called, so a future change that starts reading
 * schedules from this context fails loudly instead of silently hitting
 * production Firestore from a webhook handler. */
const unreachableScheduleStore: ScheduleStore = {
  readSchedule: () => {
    throw new Error('push-watch: scheduleStore is not available here');
  },
  writeSchedule: () => {
    throw new Error('push-watch: scheduleStore is not available here');
  },
  listSchedules: () => {
    throw new Error('push-watch: scheduleStore is not available here');
  },
  listEnabledSchedules: () => {
    throw new Error('push-watch: scheduleStore is not available here');
  },
};

/** Crockford base32 (no I, L, O, U) — the same alphabet `libs/work/src/cron.ts`'s
 * `slotItemId` and `libs/work/src/ulid.ts`'s `ulid` each keep their own copy
 * of, deliberately: those two modules stay free of a shared dependency for
 * one ten-line helper (see `cron.ts`'s own comment). This module is a third,
 * unrelated concern (webhook admission, not scheduling), so it keeps its own
 * copy for the same reason rather than introducing the cross-module
 * dependency those two explicitly avoided. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockfordTimePrefix(epochMs: number): string {
  let time = epochMs;
  let prefix = '';
  for (let i = 0; i < 10; i += 1) {
    prefix = ALPHABET[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  return prefix;
}

/**
 * A deterministic work item id for one `(repo, sha)` push: the 10-char
 * Crockford time prefix of the *pushed commit's own* timestamp (not
 * processing time — see below) followed by 16 Crockford characters derived
 * from `sha256("push:" + repo + ":" + sha)`. Mirrors `slotItemId`'s exact
 * shape and reasoning (`libs/work/src/cron.ts`): retrying the same delivery,
 * or a redelivery of the same push, always produces the same id, so
 * `mintItem` is idempotent for free — a duplicate delivery hits the item the
 * first mint already created instead of starting a second run.
 *
 * The prefix uses the commit's authored timestamp rather than
 * `Date.now()` at processing time deliberately: a retry processed seconds
 * or minutes later must derive the *same* id, which only holds if every
 * input to the derivation is a fact about the push itself, never about when
 * this handler happened to run.
 */
export async function pushDeliveryItemId(
  repo: string,
  sha: string,
  commitTime: Date,
): Promise<string> {
  const material = `push:${repo}:${sha}`;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 32];
  return crockfordTimePrefix(commitTime.getTime()) + suffix;
}

/** Only the fields this handler reads from a GitHub `push` webhook
 * payload. */
interface PushWebhookPayload {
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
  head_commit?: { id?: string; timestamp?: string } | null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Builds a `WorkContext` for this handler's own internal `mintItem` call.
 * There is no bearer token or console session here — the caller has already
 * authenticated via the webhook's HMAC signature, one layer up — so
 * `principal` is left unset, matching every other field's real
 * implementation rather than a stub (`sessionsFor`/`getSessionDoc`/
 * `sessionDocsForRuns` are unused by `mintItem` itself but are real, not
 * stubbed, so a future reader changing this handler to build a richer
 * response doesn't inherit a silent gap).
 *
 * `grants` deliberately re-parses `AGENT_LCARS_WORK_GRANTS` on every call
 * instead of reusing `work-grants.ts`'s cached `workGrants()` singleton:
 * this path runs rarely (a repo-tools push, not every HTTP request), so the
 * parse cost the cache exists to avoid does not matter here, and staying
 * uncached keeps this handler's tests independent of that module-level
 * cache's lifetime. */
function pushWatchContext(runtime: OrchestratorRouteDeps): WorkContext {
  return {
    runtime,
    sessionsFor: sessionsForRuns,
    getSessionDoc: sessionForResume,
    sessionDocsForRuns,
    maxLiveRuns: workMaxLiveRuns(),
    scheduleStore: unreachableScheduleStore,
    grants: () => parseWorkGrants(optional('AGENT_LCARS_WORK_GRANTS')),
    now: () => new Date(),
  };
}

/**
 * Handles a `push` GitHub webhook delivery: if the repository is
 * push-watched (`AGENT_LCARS_PUSH_WATCHED_REPOS`) and the push moved
 * `refs/heads/main`, mints a native work item asking an agent to check
 * whether the fleet needs to react — see the work item's own description
 * text below for its exact, deliberately advisory-only scope.
 *
 * Never targets the pushing repository itself: this always targets
 * {@link pushWatchTargetRepo}, an already-admitted control-plane
 * repository (`AGENT_LCARS_PUSH_WATCH_TARGET_REPO`), so the pushing
 * repository never needs to become dispatch-eligible itself.
 */
export async function handlePushWebhookDelivery(
  deps: OrchestratorRouteDeps,
  input: { deliveryId: string; payload: unknown },
): Promise<RouteResult> {
  const payload = input.payload as PushWebhookPayload;
  const repo = payload.repository?.full_name;
  const sha = payload.after;
  const commitTimestamp = payload.head_commit?.timestamp;

  if (
    repo === undefined ||
    sha === undefined ||
    !isPushWatchedRepository(repo) ||
    payload.ref !== 'refs/heads/main' ||
    // A deleted ref (branch delete) pushes an all-zero `after` sha with no
    // `head_commit` — nothing to react to.
    commitTimestamp === undefined
  ) {
    return {
      status: 200,
      body: { deliveryId: input.deliveryId, ignored: 'not-push-watched' },
    };
  }

  const id = await pushDeliveryItemId(repo, sha, new Date(commitTimestamp));
  const targetRepo = pushWatchTargetRepo();
  const homeRepo = controlPlaneRepository();
  const spec = {
    title: `${repo} main advanced to ${shortSha(sha)}`,
    description:
      `\`${repo}\`'s main branch advanced to \`${sha}\` ` +
      `(https://github.com/${repo}/commit/${sha}). Check whether this ` +
      "affects the fleet: whether `homelab-runner`'s currently-published " +
      `image is now meaningfully stale relative to this ${repo} ` +
      `revision (see docs/image-publish-routing.md in ${homeRepo} ` +
      '— publishing is intentionally a deliberate homelab-side operation, ' +
      'so do not run the publisher yourself, this is advisory only), and ' +
      "whether any consuming repo's guidance/docs need updating. If action " +
      'is warranted, search for an existing open tracking issue in ' +
      `${targetRepo} first and update it rather than creating a ` +
      'duplicate; only open a new one if none exists. If nothing warrants ' +
      'action, park with a brief note rather than opening or updating ' +
      'anything.',
    pipeline: PUSH_WATCH_PIPELINE,
    target: { repo: targetRepo },
  } as const;

  const context = pushWatchContext(deps);
  // Distinct from `forbiddenReason`'s check below (which `mintItem` runs
  // internally on the grant it's handed): this only confirms a grant row
  // for `PUSH_WATCH_PRINCIPAL` exists at all in `AGENT_LCARS_WORK_GRANTS`,
  // since `grantForPrincipal` returns `undefined` rather than throwing when
  // it doesn't — an unconfigured deployment refuses cleanly instead of
  // crashing on `grant.pipelines`.
  const grant = grantForPrincipal(PUSH_WATCH_PRINCIPAL, context.grants());
  if (grant === undefined) {
    console.error(
      'agent-lcars: push-watch mint refused, no grant configured for',
      PUSH_WATCH_PRINCIPAL,
    );
    return {
      status: 200,
      body: { deliveryId: input.deliveryId, refused: 'no grant configured' },
    };
  }

  const result = await mintItem(context, {
    id,
    spec,
    origin: { principal: PUSH_WATCH_PRINCIPAL, channel: 'github' },
    grantsPrincipal: {
      principal: PUSH_WATCH_PRINCIPAL,
      pipelines: grant.pipelines,
    },
  });

  if (result.kind === 'forbidden' || result.kind === 'conflict') {
    console.error('agent-lcars: push-watch mint refused', result.message);
    return {
      status: 200,
      body: { deliveryId: input.deliveryId, refused: result.message },
    };
  }
  if (result.kind === 'cap') {
    return {
      status: 200,
      body: { deliveryId: input.deliveryId, refused: 'cap' },
    };
  }

  await deps.drain();
  return {
    status: 200,
    body: {
      deliveryId: input.deliveryId,
      workId: id,
      existing: result.kind === 'existing',
    },
  };
}
