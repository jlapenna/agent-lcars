import { optional } from '@repo/env';

/**
 * The checkout this host watcher is scoped to. Every source's default
 * privacy allowlist (`allowlist.ts`, `config.ts`'s Codex cwd allowlist,
 * `antigravity-summary-source.ts`'s workspace prefixes) derives from this
 * one root, so the three sources' different encodings of it can't drift
 * apart.
 *
 * Deployment config, not app behavior — see `docs/deployment-boundary.md`.
 * `AGENT_TELEMETRY_CHECKOUT_ROOT` overrides it; the fallback is this
 * deployment's (pike, single-tenant for one checkout).
 *
 * The fallback was `/home/jlapenna/p/members` until the repo was renamed to
 * `sprinkles`. That path is now an empty husk with no git remote, while the
 * live checkout — and the Claude project dir actually being written to — is
 * `/home/jlapenna/p/sprinkles`. The allowlist is an exact-prefix glob, so
 * `-home-jlapenna-p-sprinkles` never matched `-home-jlapenna-p-members*`:
 * any watcher relying on this default was silently dropping every session
 * from the repo it exists to watch. The rename was already handled for repo
 * *identity* (`git-repo.ts`'s LEGACY_REPO_ALIASES); this path-shaped copy of
 * it was missed.
 *
 * A function rather than a const: as a const it would freeze whatever the
 * environment held at import time.
 */
/** This deployment's own checkout (pike, single-tenant). */
const DEPLOYMENT_CHECKOUT_ROOT = '/home/jlapenna/p/sprinkles';

export function checkoutRoot(): string {
  // Blank and `/` both fall back rather than being honored, because this
  // value can only ever WIDEN scope when it degrades. An empty override
  // makes the derived Claude glob `*` and the Codex glob `/*`, and leaves
  // the Antigravity prefix empty — at which point `isUnderPrefix`'s
  // `startsWith` accepts every absolute path, and the watcher ships
  // telemetry for every project on the workstation. That is the privacy
  // incident `allowlist.ts` exists to prevent, so this fails CLOSED (to
  // this deployment's own checkout) rather than open.
  //
  // A set-but-empty variable is not hypothetical: it is what a workflow or
  // compose file interpolating an undefined value produces.
  const raw = optional('AGENT_TELEMETRY_CHECKOUT_ROOT')?.trim();
  if (!raw) return DEPLOYMENT_CHECKOUT_ROOT;

  // Trailing separators are normalized rather than passed through: the
  // three consumers encode this root differently, so `/srv/thing/` would
  // otherwise yield a Claude glob of `-srv-thing-*` (excluding the checkout
  // itself), a Codex glob of `/srv/thing/*` (same), and an Antigravity
  // prefix of `/srv/thing//` (excluding everything). `/` alone normalizes
  // to empty and falls back, for the same reason blank does.
  const normalized = raw.replace(/\/+$/, '');
  return normalized || DEPLOYMENT_CHECKOUT_ROOT;
}

/** Claude Code's `~/.claude/projects/<slug>` directory-name encoding of
 * {@link checkoutRoot} (`/` replaced with `-`, including the leading one),
 * as a `*`-wildcard glob. The trailing `*` is what admits this checkout's
 * worktrees (`<root>/.claude/worktrees/<name>`) alongside the root itself. */
export function checkoutSlugGlob(): string {
  return `${checkoutRoot().replace(/\//g, '-')}*`;
}
