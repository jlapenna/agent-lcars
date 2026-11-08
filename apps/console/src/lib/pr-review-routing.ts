import {
  AGENT_LABELS,
  type AgentPipeline,
  DISPATCH_PIPELINES,
} from '@agent-lcars/dispatch-contracts';

export const UNIFIED_REVIEW_LABEL = 'review';
export const UNIFIED_REVIEW_COMMAND = '/review';

const AUTOMATED_BOT_LOGINS = new Set([
  'renovate[bot]',
  'app/renovate',
  'dependabot[bot]',
  'app/dependabot',
  'github-actions[bot]',
]);

const ATTEMPT_CLAIM_RE = /<!--\s*attempt-claim:g\d+:([^\s>]+)\s*-->/gu;

/**
 * Extracts the originating Run ID from the last `<!-- attempt-claim:g<n>:<runId> -->`
 * marker in a pull request body, if present.
 */
export function parseAttemptClaimRunId(
  body: string | null | undefined,
): string | undefined {
  if (!body) return undefined;
  let lastRunId: string | undefined;
  for (const match of body.matchAll(ATTEMPT_CLAIM_RE)) {
    if (match[1]) lastRunId = match[1];
  }
  return lastRunId;
}

export function isAutomatedReviewExcludedAuthor(
  login: string | undefined,
): boolean {
  if (!login) return false;
  return AUTOMATED_BOT_LOGINS.has(login.toLowerCase());
}

export interface PullRequestAuthorSignals {
  /** Authoritative pipeline from the store's originating implement Run. */
  authorPipelineFromStore?: AgentPipeline;
  labels?: readonly { name: string }[];
  userLogin?: string;
  body?: string | null;
  headRef?: string;
}

function detectAuthorFromBody(
  body: string | null | undefined,
): AgentPipeline | undefined {
  if (!body) return undefined;
  if (
    /\bClaude-Session:\s*https?:\/\/claude\.ai\/code\/session_/iu.test(body) ||
    /Co-Authored-By:\s*Claude\b/iu.test(body)
  ) {
    return 'claude';
  }
  if (/Co-Authored-By:\s*Codex\b/iu.test(body)) {
    return 'codex';
  }
  if (/Co-Authored-By:\s*(?:Antigravity|Gemini)\b/iu.test(body)) {
    return 'agy';
  }
  if (/Co-Authored-By:\s*OpenCode\b/iu.test(body)) {
    return 'opencode';
  }
  return undefined;
}

function detectAuthorFromHeadRef(
  headRef: string | undefined,
): AgentPipeline | undefined {
  if (!headRef) return undefined;
  const normalized = headRef.toLowerCase();
  if (normalized.startsWith('claude/')) return 'claude';
  if (normalized.startsWith('codex/')) return 'codex';
  if (normalized.startsWith('agy/') || normalized.startsWith('antigravity/')) {
    return 'agy';
  }
  if (normalized.startsWith('opencode/')) return 'opencode';
  return undefined;
}

/**
 * Determines which agent pipeline authored a pull request so review intake
 * can select an opposite model and avoid self-review.
 */
export function detectPullRequestAuthorPipeline(
  input: PullRequestAuthorSignals,
): AgentPipeline | undefined {
  if (input.authorPipelineFromStore !== undefined) {
    return input.authorPipelineFromStore;
  }

  const agentLabels = [
    ...new Set(
      (input.labels ?? [])
        .map((label) => AGENT_LABELS.get(label.name))
        .filter(
          (pipeline): pipeline is AgentPipeline => pipeline !== undefined,
        ),
    ),
  ];
  if (agentLabels.length === 1) {
    return agentLabels[0];
  }

  const login = input.userLogin?.toLowerCase();
  if (login === 'claude[bot]') {
    return 'claude';
  }

  const fromBody = detectAuthorFromBody(input.body);
  if (fromBody !== undefined) {
    return fromBody;
  }

  const fromBranch = detectAuthorFromHeadRef(input.headRef);
  if (fromBranch !== undefined) {
    return fromBranch;
  }

  if (login === 'agent-lcars[bot]') {
    return 'codex';
  }

  return undefined;
}

export interface CrossModelReviewSelection {
  pipeline: AgentPipeline;
  fallbackPipelines: AgentPipeline[];
  crossModelOverride: boolean;
}

function defaultCrossModelOrder(
  authorPipeline: AgentPipeline | undefined,
): readonly AgentPipeline[] {
  switch (authorPipeline) {
    case 'codex':
      return ['claude', 'agy'];
    case 'claude':
      return ['codex', 'agy'];
    case 'agy':
      return ['claude', 'codex'];
    case 'opencode':
      return ['claude', 'codex', 'agy'];
    case undefined:
      return ['claude', 'codex', 'agy'];
  }
}

/**
 * Selects the primary reviewer pipeline and ordered quota-fallback pipelines
 * for a pull request:
 * - Codex PRs are reviewed by Claude with Antigravity (`agy`) as fallback.
 * - Claude PRs are reviewed by Codex with Antigravity (`agy`) as fallback.
 * - Antigravity (`agy`) PRs are reviewed by Claude with Codex as fallback
 *   (or Codex with Claude as fallback when explicitly requested).
 * - If an explicit `review:<pipeline>` label names the same pipeline that
 *   authored the PR, `crossModelOverride` redirects the review to the opposite
 *   model so an agent never reviews its own PR.
 */
export function selectCrossModelReviewer(input: {
  repo: string;
  authorPipeline?: AgentPipeline;
  requestedPipeline?: AgentPipeline;
  supportedPipelines?: readonly AgentPipeline[];
}): CrossModelReviewSelection {
  const repoSupported = input.supportedPipelines ?? DISPATCH_PIPELINES;
  const supportedSet = new Set<AgentPipeline>(
    repoSupported.length > 0 ? repoSupported : DISPATCH_PIPELINES,
  );

  const crossModelOverride =
    input.requestedPipeline !== undefined &&
    input.authorPipeline !== undefined &&
    input.requestedPipeline === input.authorPipeline;

  const effectiveRequested = crossModelOverride
    ? undefined
    : input.requestedPipeline;

  const baseOrder = defaultCrossModelOrder(input.authorPipeline);
  const candidates: AgentPipeline[] = [];

  if (effectiveRequested !== undefined) {
    candidates.push(effectiveRequested);
    // When an explicit cross-model reviewer is requested (e.g. review:claude or
    // review:codex), prioritize Antigravity (`agy`) first on quota exhaustion
    // before falling back to other non-author reviewers.
    for (const candidate of ['agy', ...baseOrder] as const) {
      if (
        candidate !== input.authorPipeline &&
        !candidates.includes(candidate)
      ) {
        candidates.push(candidate);
      }
    }
  } else {
    for (const candidate of baseOrder) {
      if (
        candidate !== input.authorPipeline &&
        !candidates.includes(candidate)
      ) {
        candidates.push(candidate);
      }
    }
  }

  const supportedCandidates = candidates.filter((candidate) =>
    supportedSet.has(candidate),
  );

  const [primary, ...fallbackPipelines] =
    supportedCandidates.length > 0
      ? supportedCandidates
      : [effectiveRequested ?? baseOrder[0] ?? 'claude'];

  return {
    pipeline: primary,
    fallbackPipelines,
    crossModelOverride,
  };
}
