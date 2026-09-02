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
 * The identity variables ({@link maintainerLogin}, {@link consoleUrl},
 * {@link artifactShareBaseUrl}, {@link pushWatchTargetRepo},
 * {@link consoleRepositoryUrl}) are `required()`: there is no fallback to
 * this deployment's own values, so a fork that forgets to set one fails
 * loudly instead of silently inheriting this fleet's identity (#1731).
 * {@link validateDeploymentIdentity} calls every one of them eagerly from
 * `instrumentation.ts`'s `register()`, so a missing variable fails at
 * process startup with a clear message rather than on whichever request
 * happens to touch it first. `apphosting.yaml` is the one place this
 * deployment's concrete values live now.
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
  return required('AGENT_LCARS_ADMIN_GITHUB_LOGIN');
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

/**
 * Copy identifying this console deployment in metadata and auth surfaces.
 * Deliberately `optional()`, not `required()`: `layout.tsx`'s static
 * `export const metadata` object evaluates this at module load, which runs
 * during `next build` itself (confirmed empirically -- a `required()` read
 * here fails the production build, not just a request, before any runtime
 * env is available to satisfy it). The generic fallback names the product,
 * never a specific deployment, so an unconfigured fork still builds and
 * gets a truthful-if-generic description rather than another fleet's name.
 */
export function consoleDescription(): string {
  return (
    optional('AGENT_LCARS_CONSOLE_DESCRIPTION') ??
    'Agent LCARS — multi-agent issue activity'
  );
}

/**
 * Repository that contains and deploys this console. Derived from
 * {@link controlPlaneRepository} -- "the repository whose controller this
 * backend hosts" is exactly "the repository that deploys this console" --
 * rather than a second, redundant env var. Unlike {@link consoleDescription},
 * this is safe as `required()`: every caller renders inside the console's
 * dynamic (cookie/header-gated) render tree, never from build-time static
 * metadata (confirmed empirically alongside the above).
 */
export function consoleRepositoryUrl(): string {
  return `https://github.com/${controlPlaneRepository()}`;
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
  return required('AGENT_LCARS_CONSOLE_URL');
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

/**
 * Repositories whose `push` webhook events mint a native "reconcile the
 * fleet" work item (see `push-watch.ts`) — deliberately separate from
 * {@link controlPlaneRepositories}. A repository here is *not* thereby made
 * eligible for the fleet's full issue/PR dispatch machinery; it is only
 * observed for its `main` branch moving. Parsed once from
 * `AGENT_LCARS_PUSH_WATCHED_REPOS` (a comma-separated `owner/name` list).
 *
 * Unset or empty means nothing is push-watched — this feature is additive
 * and opt-in, unlike {@link controlPlaneRepositories} (which throws on
 * misconfiguration because accepting an anchor with no rendering path is a
 * bug, not a degraded mode). There is no anchor here to render; an absent
 * or malformed entry just means fewer repositories are watched.
 */
export function pushWatchedRepos(): string[] {
  const raw = optional('AGENT_LCARS_PUSH_WATCHED_REPOS') ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => OWNER_NAME_PATTERN.test(entry));
}

/** Exact, case-sensitive membership check against {@link pushWatchedRepos}. */
export function isPushWatchedRepository(fullName: string): boolean {
  return pushWatchedRepos().includes(fullName);
}

/**
 * Repository the work item minted by `push-watch.ts` always targets --
 * already an admitted {@link controlPlaneRepositories} entry, distinct from
 * whichever push-watched repository actually triggered the mint. `push-watch.ts`
 * used to hard-code this as `PUSH_WATCH_TARGET_REPO`; there was no override,
 * so a fork inherited this fleet's target with no way to redirect it.
 */
export function pushWatchTargetRepo(): string {
  const raw = required('AGENT_LCARS_PUSH_WATCH_TARGET_REPO');
  if (!OWNER_NAME_PATTERN.test(raw)) {
    throw new Error(
      `AGENT_LCARS_PUSH_WATCH_TARGET_REPO ${JSON.stringify(raw)} is not a valid owner/name repository`,
    );
  }
  return raw;
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
 * `required()`, not a jlapenna-shaped fallback (#1731): an unconfigured
 * fork should fail closed at startup, not silently link every shared
 * artifact at this fleet's share host.
 */
export function artifactShareBaseUrl(): string {
  return required('AGENT_LCARS_ARTIFACT_SHARE_BASE_URL');
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

/**
 * Eagerly reads every `required()` deployment-identity variable once at
 * process startup (`instrumentation.ts`'s `register()`), so a missing one
 * fails the boot with a clear `process.env.<NAME> not defined` message
 * instead of surfacing later on whichever request happens to touch it
 * first (#1731). `consoleDescription` is intentionally excluded: it is
 * `optional()` with a generic, deployment-neutral fallback (see its own
 * doc comment) precisely because it is evaluated at build time, before any
 * runtime env is available to validate.
 */
export function validateDeploymentIdentity(): void {
  maintainerLogin();
  consoleUrl();
  artifactShareBaseUrl();
  pushWatchTargetRepo();
  consoleRepositoryUrl();
}
