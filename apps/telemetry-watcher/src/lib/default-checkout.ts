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
export function checkoutRoot(): string {
  return (
    optional('AGENT_TELEMETRY_CHECKOUT_ROOT') ?? '/home/jlapenna/p/sprinkles'
  );
}

/** Claude Code's `~/.claude/projects/<slug>` directory-name encoding of
 * {@link checkoutRoot} (`/` replaced with `-`, including the leading one),
 * as a `*`-wildcard glob. The trailing `*` is what admits this checkout's
 * worktrees (`<root>/.claude/worktrees/<name>`) alongside the root itself. */
export function checkoutSlugGlob(): string {
  return `${checkoutRoot().replace(/\//g, '-')}*`;
}
