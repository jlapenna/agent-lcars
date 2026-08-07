import { optional } from '@agent-lcars/env';
import * as path from 'path';

const ROOTS_VAR = 'AGENT_TELEMETRY_CHECKOUT_ROOTS';
const LEGACY_ROOT_VAR = 'AGENT_TELEMETRY_CHECKOUT_ROOT';

function normalizeRoot(raw: string, variable: string): string {
  const normalized = raw.trim().replace(/\/+$/, '');
  if (!normalized || normalized === '/' || !path.isAbsolute(normalized)) {
    throw new Error(
      `${variable} entries must be absolute checkout paths other than /`,
    );
  }
  return normalized;
}

/**
 * Checkout roots this host watcher may ship telemetry for. This is a privacy
 * boundary, so production host-watcher mode has no built-in path: deployment
 * must name its real checkouts explicitly instead of silently inheriting a
 * developer-specific home directory or a path that can go stale after a
 * rename. Runner mode never calls this function because its single-purpose
 * container deliberately has no checkout allowlist.
 *
 * `AGENT_TELEMETRY_CHECKOUT_ROOT` remains a single-root compatibility alias;
 * new deployments should use the comma-separated plural variable.
 */
export function checkoutRoots(): string[] {
  const plural = optional(ROOTS_VAR);
  const legacy = optional(LEGACY_ROOT_VAR);
  const variable = plural !== undefined ? ROOTS_VAR : LEGACY_ROOT_VAR;
  const raw = plural ?? legacy;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `${ROOTS_VAR} must explicitly name at least one checkout root`,
    );
  }

  const entries = raw.split(',');
  if (entries.some((entry) => entry.trim() === '')) {
    throw new Error(`${variable} contains an empty checkout path`);
  }

  return [...new Set(entries.map((entry) => normalizeRoot(entry, variable)))];
}

/** First configured root, retained for single-root compatibility callers. */
export function checkoutRoot(): string {
  return checkoutRoots()[0];
}

/** Claude Code project-directory encodings for every configured root. */
export function checkoutSlugGlobs(): string[] {
  return checkoutRoots().map((root) => `${root.replace(/\//g, '-')}*`);
}

/** First configured slug, retained for single-root compatibility callers. */
export function checkoutSlugGlob(): string {
  return checkoutSlugGlobs()[0];
}
