export const DELIVERABLE_WATCHDOG_MARKER_PREFIX =
  '<!-- agent-lcars:deliverable-watchdog:v1:pr=';
export const WATCHDOG_ATTENTION_STATE = '**Watchdog state:** needs-attention';
export const WATCHDOG_RECOVERED_STATE = '**Watchdog state:** activity-resumed';

export interface DeliverablePullRequest {
  number: number;
  url: string;
  authorLogin: string;
  createdAt: string;
  headCommittedAt: string;
  headSha: string;
  isDraft: boolean;
  anchors: number[];
}

export interface DeliverableCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
}

export interface DeliverableEvaluation {
  needsAttention: boolean;
  activityAt: string;
  ageMs: number;
  check: DeliverableCheckRun | undefined;
  reason: string;
}

function timestamp(value: string | null | undefined, field: string): number {
  if (!value) throw new Error(`${field} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${field} is invalid: ${value}`);
  return parsed;
}

function optionalTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function normalizeGraphqlBotLogin(login: string): string {
  return login.startsWith('app/') ? `${login.slice(4)}[bot]` : login;
}

export function parseAgentBotLogins(raw: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('AGENT_BOT_LOGINS must be valid JSON', { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((login) => typeof login !== 'string' || login.length === 0)
  ) {
    throw new Error(
      'AGENT_BOT_LOGINS must be a non-empty JSON array of logins',
    );
  }
  return new Set(parsed);
}

function checkActivity(check: DeliverableCheckRun): number {
  return Math.max(
    optionalTimestamp(check.completedAt),
    optionalTimestamp(check.startedAt),
  );
}

export function selectLatestRequiredCheck(
  checks: DeliverableCheckRun[],
  requiredCheck: string,
): DeliverableCheckRun | undefined {
  return checks
    .filter((check) => check.name === requiredCheck)
    .sort((left, right) => {
      const activityDelta = checkActivity(right) - checkActivity(left);
      return activityDelta || right.id - left.id;
    })[0];
}

export function evaluateDeliverable(
  pullRequest: DeliverablePullRequest,
  checks: DeliverableCheckRun[],
  requiredCheck: string,
  staleAfterMs: number,
  now: Date,
): DeliverableEvaluation {
  const check = selectLatestRequiredCheck(checks, requiredCheck);
  const activityMs = Math.max(
    timestamp(pullRequest.createdAt, `PR #${pullRequest.number} createdAt`),
    timestamp(
      pullRequest.headCommittedAt,
      `PR #${pullRequest.number} head committedAt`,
    ),
    check ? checkActivity(check) : Number.NEGATIVE_INFINITY,
  );
  const ageMs = Math.max(0, now.getTime() - activityMs);
  const activityAt = new Date(activityMs).toISOString();
  if (ageMs < staleAfterMs) {
    return {
      needsAttention: false,
      activityAt,
      ageMs,
      check,
      reason:
        'head or required-check activity is still inside the watchdog window',
    };
  }

  let reason: string;
  if (!check) {
    reason = `required check ${requiredCheck} is missing`;
  } else if (check.status !== 'completed') {
    reason = `required check ${requiredCheck} is still ${check.status}`;
  } else if (check.conclusion === 'success') {
    reason = `required check ${requiredCheck} passed, but the PR remains open`;
  } else {
    reason = `required check ${requiredCheck} concluded ${check.conclusion ?? 'without a conclusion'}`;
  }
  if (pullRequest.isDraft) reason += '; the PR is still a draft';

  return {
    needsAttention: true,
    activityAt,
    ageMs,
    check,
    reason,
  };
}

export function watchdogMarker(prNumber: number): string {
  return `${DELIVERABLE_WATCHDOG_MARKER_PREFIX}${prNumber} -->`;
}

function ageHours(ageMs: number): string {
  return (ageMs / (60 * 60 * 1000)).toFixed(1);
}

export function renderAttentionComment(
  pullRequest: DeliverablePullRequest,
  evaluation: DeliverableEvaluation,
  requiredCheck: string,
): string {
  const checkUrl = evaluation.check?.url
    ? `\n- Required check: [${requiredCheck}](${evaluation.check.url})`
    : '';
  return `${watchdogMarker(pullRequest.number)}

### Agent deliverable needs attention

${WATCHDOG_ATTENTION_STATE}

[PR #${pullRequest.number}](${pullRequest.url}) has remained open with no head-commit or required-check activity for ${ageHours(evaluation.ageMs)} hours.

- Last activity: ${evaluation.activityAt}
- Reason: ${evaluation.reason}${checkUrl}

This watchdog never rebases or merges a PR. A maintainer must inspect the deliverable and decide whether to rerun checks, update, merge, close, or supersede it.`;
}

export function renderRecoveredComment(
  pullRequest: DeliverablePullRequest,
  evaluation: DeliverableEvaluation,
): string {
  return `${watchdogMarker(pullRequest.number)}

### Agent deliverable activity resumed

${WATCHDOG_RECOVERED_STATE}

[PR #${pullRequest.number}](${pullRequest.url}) has new head-commit or required-check activity as of ${evaluation.activityAt}, so it is no longer beyond the watchdog window.

The shared status:needs-human label is intentionally left in place: this watchdog cannot prove that no other dispatch or reporting failure owns that label. A maintainer can clear it after reviewing the task.`;
}
