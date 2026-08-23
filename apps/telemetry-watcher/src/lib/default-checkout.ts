import { optional } from '@agent-lcars/env';
import * as path from 'path';

const ROOTS_VAR = 'AGENT_TELEMETRY_CHECKOUT_ROOTS';

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
 */
export function checkoutRoots(): string[] {
  const raw = optional(ROOTS_VAR);
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `${ROOTS_VAR} must explicitly name at least one checkout root`,
    );
  }

  const entries = raw.split(',');
  if (entries.some((entry) => entry.trim() === '')) {
    throw new Error(`${ROOTS_VAR} contains an empty checkout path`);
  }

  return [...new Set(entries.map((entry) => normalizeRoot(entry, ROOTS_VAR)))];
}

/** Claude Code project-directory encodings for every configured root. */
export function checkoutSlugGlobs(): string[] {
  return checkoutRoots().map((root) => `${root.replace(/\//g, '-')}*`);
}
