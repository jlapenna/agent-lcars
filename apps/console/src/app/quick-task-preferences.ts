import type { AgentPipeline } from '../lib/watched-repo';

export const QUICK_TASK_PREFERENCES_STORAGE_KEY =
  'agent-lcars:quick-task-preferences:v1';

export interface QuickTaskPreferences {
  repoKey?: string;
  pipeline?: AgentPipeline;
}

function isAgentPipeline(value: unknown): value is AgentPipeline {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}

/** Read the browser-local Quick Task defaults. Invalid or unavailable
 * storage is equivalent to having no remembered selection. */
export function readQuickTaskPreferences(): QuickTaskPreferences {
  try {
    const raw = window.localStorage.getItem(QUICK_TASK_PREFERENCES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const candidate = parsed as Record<string, unknown>;
    return {
      repoKey:
        typeof candidate.repoKey === 'string' && candidate.repoKey.length > 0
          ? candidate.repoKey
          : undefined,
      pipeline: isAgentPipeline(candidate.pipeline)
        ? candidate.pipeline
        : undefined,
    };
  } catch {
    return {};
  }
}

/** Persist only the stable repository identity and pipeline selection. */
export function writeQuickTaskPreferences(
  preferences: Required<QuickTaskPreferences>,
): void {
  try {
    window.localStorage.setItem(
      QUICK_TASK_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Storage can be disabled or full. Remembering defaults is optional and
    // must never prevent the task itself from being filed.
  }
}
