export type ClaudeReadinessState = 'credential-failure' | 'healthy' | 'unknown';

interface ClaudeExecutionResult {
  type?: unknown;
  subtype?: unknown;
  api_error_status?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
}

function terminalResult(execution: unknown): ClaudeExecutionResult | undefined {
  if (!Array.isArray(execution) || execution.length === 0) return undefined;
  const results = execution.filter(
    (message): message is ClaudeExecutionResult =>
      !!message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as ClaudeExecutionResult).type === 'result',
  );
  const last = execution.at(-1);
  if (
    results.length !== 1 ||
    !last ||
    typeof last !== 'object' ||
    Array.isArray(last) ||
    (last as ClaudeExecutionResult).type !== 'result'
  ) {
    return undefined;
  }
  return last as ClaudeExecutionResult;
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
  const result = terminalResult(execution);
  if (!result) return 'unknown';
  if (
    actionConclusion === 'failure' &&
    result.subtype === 'success' &&
    result.is_error === true &&
    result.api_error_status === 401 &&
    result.total_cost_usd === 0
  ) {
    return 'credential-failure';
  }
  if (
    actionConclusion === 'success' &&
    result.subtype === 'success' &&
    result.is_error === false &&
    (result.api_error_status === undefined ||
      result.api_error_status === null) &&
    typeof result.total_cost_usd === 'number' &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
  ) {
    return 'healthy';
  }
  return 'unknown';
}
