/**
 * This deployment (pike) is single-tenant for one checkout. Every source's
 * default privacy allowlist (`allowlist.ts`, `config.ts`'s Codex cwd
 * allowlist, `antigravity-summary-source.ts`'s workspace prefixes) scopes
 * to this same root — kept in one place so the three sources' different
 * encodings of it can't drift out of sync with each other.
 */
export const DEFAULT_CHECKOUT_ROOT = '/home/jlapenna/p/members';

/** Claude Code's `~/.claude/projects/<slug>` directory-name encoding of
 * `DEFAULT_CHECKOUT_ROOT` (`/` replaced with `-`, including the leading
 * one), as a `*`-wildcard glob. */
export const DEFAULT_CHECKOUT_SLUG_GLOB = `${DEFAULT_CHECKOUT_ROOT.replace(/\//g, '-')}*`;
