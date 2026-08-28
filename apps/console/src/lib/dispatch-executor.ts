import 'server-only';

import type { RunExecutor } from '@agent-lcars/orchestrator';

/**
 * The fleet is moving every broker run onto the direct queue executor.  This
 * is deliberately one deployment-wide migration switch, rather than a
 * per-pipeline routing list: once enabled, admission is identical for
 * Claude, Codex, and OpenCode no matter whether it came from GitHub, the
 * console, an internal workflow, or native Work.
 *
 * The false/default branch is temporary rollout safety. It preserves the
 * established hosted executor until the runner image supports every provider;
 * no request source or provider can choose an alternate route.
 */
export function dispatchExecutor(
  env: Record<string, string | undefined> = process.env,
): RunExecutor | undefined {
  const raw = env['AGENT_LCARS_UNIFIED_QUEUE_ENABLED'];
  if (raw === undefined || raw.trim() === '' || raw === 'false') {
    return undefined;
  }
  if (raw === 'true') return 'queue';
  throw new Error(
    'AGENT_LCARS_UNIFIED_QUEUE_ENABLED must be true or false when set',
  );
}
