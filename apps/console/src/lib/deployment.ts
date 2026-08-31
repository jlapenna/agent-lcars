import 'server-only';

import { optional, required } from '@agent-lcars/util-server';

import { repoKey } from './watched-repo';
import { getWatchedRepos } from './watched-repos-config';

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
 * Server-only: `@agent-lcars/util-server` must never reach a client bundle. Client
 * components that need one of these take it as a prop from a server
 * component — see `shareArtifactUrl`'s callers.
 */

/** The human this console serves. Review requests are matched against this
 * login. Console authorization is configured separately by
 * {@link adminGithubLogins}, so adding another operator does not change whose
 * review queue the console curates. */
export function maintainerLogin(): string {
  return optional('AGENT_LCARS_ADMIN_GITHUB_LOGIN') ?? 'jlapenna';
}

/** GitHub logins authorized to operate this console. The plural setting is
 * intentionally separate from {@link maintainerLogin}: multiple people may
 * operate the console while its queue remains owned by one maintainer.
 *
 * Falling back to the maintainer login preserves the original single-admin
 * behavior for local development and deployments that have not set the new
 * list. GitHub logins are case-insensitive, so the parsed values are
 * canonicalized before comparison. */
export function adminGithubLogins(): string[] {
  const raw = optional('AGENT_LCARS_ADMIN_GITHUB_LOGINS') ?? maintainerLogin();
  const logins = raw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);

  if (logins.length === 0) {
    throw new Error(
      'AGENT_LCARS_ADMIN_GITHUB_LOGINS must list at least one GitHub login when set',
    );
  }

  return [...new Set(logins)];
}

export function isAdminGithubLogin(login: unknown): boolean {
  return (
    typeof login === 'string' &&
    adminGithubLogins().includes(login.toLowerCase())
  );
}

/** The machine user the agent fleet claims work as. Direct workers assign it
 * to the anchor issue at run start, and agent-authored PR handling assigns it
 * to PRs, so "assigned to
 * this login" is the fleet's ownership marker (see agent-protocol.md §10 —
 * the bot App identity itself is not assignable, which is why a real
 * account stands in for it). */
export function agentFleetLogin(): string {
  return optional('AGENT_LCARS_FLEET_GITHUB_LOGIN') ?? 'agent-lcars-bot';
}

/** Copy identifying this console deployment in metadata and auth surfaces. */
export function consoleDescription(): string {
  return 'jlapenna/agent-lcars — multi-agent issue activity';
}

/** Repository that contains and deploys this console. */
export function consoleRepositoryUrl(): string {
  return 'https://github.com/jlapenna/agent-lcars';
}

/**
 * This console deployment's own public base URL -- used to build a link
 * back to itself for something that has no other way to know its own
 * origin (`runs-router.ts`'s `brief` handler embeds it in
 * `anchor.html_url`, the URL a direct worker follows to view a native work
 * item). Final-review fix: this used to
 * be an inline, unregistered `process.env['AGENT_LCARS_CONSOLE_URL']` read
 * in `runs-router.ts` itself -- moved here to match every other instance-
 * identity value's home, per this file's own doc comment above.
 */
export function consoleUrl(): string {
  return optional('AGENT_LCARS_CONSOLE_URL') ?? 'https://lcars.jlapenna.net';
}

/** Repository whose controller this backend hosts. GitHub Actions OIDC
 * callers must carry this exact repository claim, and reconciliation only
 * scans this repository. */
export function controlPlaneRepository(): string {
  return required('AGENT_LCARS_CONTROL_PLANE_REPOSITORY');
}

/** `owner/name`: one non-empty owner segment, one non-empty name segment,
 * no embedded `/`. Matches GitHub's own full-name shape. */
const OWNER_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

/**
 * Repositories this backend is willing to admit as control-plane callers —
 * webhook deliveries, completion/task-state lookups (see
 * {@link isControlPlaneRepository}). Parsed once from
 * `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (a comma-separated `owner/name`
 * list). It must exactly match `AGENT_LCARS_WATCHED_REPOS`: accepting an
 * anchor whose durable projection the queue will not render is an invalid
 * deployment, not a degraded single-repository mode.
 *
 * Misconfiguration throws rather than silently admitting the world: a typo'd
 * or empty entry here is a security-relevant bug, not a degrade-gracefully
 * case (mirrors `github-client.ts`'s `parseWatchedReposJson`).
 */
export function controlPlaneRepositories(): string[] {
  const raw = required('AGENT_LCARS_CONTROL_PLANE_REPOSITORIES');

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(
      'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES must list at least one owner/name repository',
    );
  }
  for (const entry of entries) {
    if (!OWNER_NAME_PATTERN.test(entry)) {
      throw new Error(
        `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES entry ${JSON.stringify(entry)} is not a valid owner/name repository`,
      );
    }
  }
  const watched = getWatchedRepos().map(repoKey);
  if (
    entries.length !== watched.length ||
    entries.some((entry) => !watched.includes(entry))
  ) {
    throw new Error(
      'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES must exactly match AGENT_LCARS_WATCHED_REPOS',
    );
  }
  return entries;
}

/** Exact, case-sensitive membership check against
 * {@link controlPlaneRepositories} — GitHub full names are case-preserving,
 * so this deliberately does not case-fold or substring-match. */
export function isControlPlaneRepository(fullName: string): boolean {
  return controlPlaneRepositories().includes(fullName);
}

/** Command used to restore archived Claude transcripts: the fleet-tools
 * PATH bin (agent-lcars#1328) — installed on workstations and baked into
 * the runner image, so it is checkout-independent. */
export function agentSessionResumeScript(): string {
  return 'fleet-claude-agent-session';
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
