import 'server-only';

import type { RunExecutor } from '@agent-lcars/orchestrator';

import { queuePipelines } from './work-grants';

/** One server-owned decision for an admitted run's pipeline. */
export type DispatchExecutor = (pipeline: string) => RunExecutor | undefined;

/**
 * The fleet is moving every broker run onto the direct queue executor.  This
 * is deliberately one deployment-wide migration switch, rather than a
 * per-pipeline routing list: once enabled, admission is identical for
 * Claude, Codex, and OpenCode no matter whether it came from GitHub, the
 * console, an internal workflow, or native Work.
 *
 * The false/default branch is temporary rollout safety. It preserves the
 * established legacy queue selection exactly until the runner image, executor
 * grant, and Homelab configuration support every provider. No request source
 * or caller can choose an alternate route.
 */
export function dispatchExecutor(
  env: Record<string, string | undefined> = process.env,
): DispatchExecutor {
  const raw = env['AGENT_LCARS_UNIFIED_QUEUE_ENABLED'];
  if (raw === 'true') return () => 'queue';
  if (raw !== undefined && raw.trim() !== '' && raw !== 'false') {
    throw new Error(
      'AGENT_LCARS_UNIFIED_QUEUE_ENABLED must be true or false when set',
    );
  }

  const legacyQueuePipelines = queuePipelines(
    env['AGENT_LCARS_QUEUE_PIPELINES'],
  );
  return (pipeline) =>
    legacyQueuePipelines.includes(pipeline) ? 'queue' : undefined;
}
