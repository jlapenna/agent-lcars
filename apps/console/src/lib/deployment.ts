import 'server-only';

import { optional } from '@repo/util-server';

/**
 * Every value that describes *this particular deployment* of the console
 * rather than the console itself — who the maintainer is, what the agent
 * fleet claims work as, where artifacts are served from.
 *
 * These used to be `const`s scattered through the modules that happened to
 * need them (`MAINTAINER_LOGIN` in action-items.ts, the share host inlined
 * in format.ts's URL template), which made "what would someone forking this
 * have to change?" a grep-and-hope question. Collecting them here makes the
 * boundary between the app and one instance of it a file boundary.
 *
 * Each reads an env var and falls back to this deployment's current value,
 * so nothing breaks if a var is unset. The fallbacks are the *only* place
 * instance identity appears in console source — changing this file plus
 * `apphosting.yaml` is the whole job. (Making them `required()` and
 * deleting the fallbacks is the stricter follow-up; it needs every test and
 * CI surface to supply them first.)
 *
 * Server-only: `@repo/util-server` must never reach a client bundle. Client
 * components that need one of these take it as a prop from a server
 * component — see `shareArtifactUrl`'s callers.
 */

/** The human this console serves. Review requests are matched against this
 * login.
 *
 * Shares `AGENT_LCARS_ADMIN_GITHUB_LOGIN` with `auth.ts`'s sign-in gate
 * rather than introducing a second var: the person allowed to log in and
 * the person the queue is curated for are the same person by construction —
 * this is a single-admin console. */
export function maintainerLogin(): string {
  return optional('AGENT_LCARS_ADMIN_GITHUB_LOGIN') ?? 'jlapenna';
}

/** The machine user the agent fleet claims work as. claude.yml/codex.yml/
 * opencode.yml assign it to the anchor issue at run start, and
 * agent-automerge.yml assigns it to agent-authored PRs, so "assigned to
 * this login" is the fleet's ownership marker (see agent-protocol.md §10 —
 * the bot App identity itself is not assignable, which is why a real
 * account stands in for it). */
export function agentFleetLogin(): string {
  return optional('AGENT_LCARS_FLEET_GITHUB_LOGIN') ?? 'jclaw-bot';
}

/** Copy identifying this console deployment in metadata and auth surfaces. */
export function consoleDescription(): string {
  return 'jlapenna/agent-lcars — multi-agent issue activity';
}

/** Repository that contains and deploys this console. */
export function consoleRepositoryUrl(): string {
  return 'https://github.com/jlapenna/agent-lcars';
}

/** Checkout-relative script used to restore archived Claude transcripts. */
export function agentSessionResumeScript(): string {
  return 'tools/claude-agent-session.sh';
}

/**
 * Base URL the share-media skill's files are served from. Files land at
 * `~/share/<conversation-id>/<filename>` on the originating host and are
 * served under `<base>/<host>/...` (LAN/Tailscale-only, behind Authelia).
 *
 * `required()`-shaped rather than optional would be wrong here: an
 * unreachable artifact link degrades to a dead link, which is strictly
 * better than refusing to render the session page at all.
 */
export function artifactShareBaseUrl(): string {
  return (
    optional('AGENT_LCARS_ARTIFACT_SHARE_BASE_URL') ??
    'https://share.lan.jlapenna.net'
  );
}

/**
 * Builds the URL for one artifact. Lives here rather than in `format.ts`
 * because that module is imported by client components
 * (`refresh-button.tsx`, `action-item-card.tsx`) and this reads server-only
 * config; both of this function's callers are server components.
 */
export function shareArtifactUrl(
  host: string,
  sessionId: string,
  filename: string,
): string {
  return `${artifactShareBaseUrl()}/${host}/${sessionId}/${filename}`;
}
