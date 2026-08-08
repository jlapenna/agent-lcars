export type ClaudeReadinessState = 'credential-failure' | 'healthy' | 'unknown';

interface ClaudeExecutionResult {
  api_error_status?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
}

/**
 * Classify only the harness-owned fields from an isolated Claude probe. The
 * caller must establish that the execution file was produced outside the
 * untrusted worker. A generic zero-cost/provider failure is not credential
 * evidence: only an explicit HTTP 401 is. Recovery is positive only when the
 * action and its structured result both report success.
 */
export function classifyClaudeReadiness(
  actionConclusion: string,
  execution: unknown,
): ClaudeReadinessState {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return 'unknown';
  }
  const result = execution as ClaudeExecutionResult;
  if (result.api_error_status === 401 && result.total_cost_usd === 0) {
    return 'credential-failure';
  }
  if (actionConclusion === 'success' && result.is_error === false) {
    return 'healthy';
  }
  return 'unknown';
}
