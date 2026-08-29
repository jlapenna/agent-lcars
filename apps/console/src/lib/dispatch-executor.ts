import 'server-only';

import type { RunExecutor } from '@agent-lcars/orchestrator';

/** One server-owned decision for an admitted run's pipeline. */
export type DispatchExecutor = (pipeline: string) => RunExecutor | undefined;

/**
 * The fleet routes every broker run onto the direct queue executor. This is
 * deliberately one deployment-wide policy, rather than a per-pipeline routing
 * list: admission is identical for
 * Claude, Codex, and OpenCode no matter whether it came from GitHub, the
 * console, an internal workflow, or native Work.
 */
export function dispatchExecutor(
  env: Record<string, string | undefined> = process.env,
): DispatchExecutor {
  const raw = env['AGENT_LCARS_UNIFIED_QUEUE_ENABLED'];
  if (raw !== 'true') {
    throw new Error(
      'AGENT_LCARS_UNIFIED_QUEUE_ENABLED must be true for the unified queue',
    );
  }
  return () => 'queue';
}
