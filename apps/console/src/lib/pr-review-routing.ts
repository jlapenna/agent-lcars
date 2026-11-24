import {
  AGENT_LABELS,
  type AgentPipeline,
  DISPATCH_PIPELINES,
} from '@agent-lcars/dispatch-contracts';

export const UNIFIED_REVIEW_LABEL = 'review';
export const UNIFIED_REVIEW_COMMAND = '/review';

const DEPENDENCY_BOT_LOGINS = new Set([
  'renovate[bot]',
  'app/renovate',
  'dependabot[bot]',
  'app/dependabot',
]);

const AUTOMATED_BOT_LOGINS = new Set([
  ...DEPENDENCY_BOT_LOGINS,
  'github-actions[bot]',
]);

/**
 * Renovate groups in `jlapenna/agent-lcars` whose updates change executable
 * review/runtime pins and require explicit review + qualification once a
 * maintainer marks their draft PR ready for review (`renovate.json`).
 */
const QUALIFICATION_REQUIRED_RENOVATE_REF_RE =
  /^renovate\/(?:major-)?(?:runner-cli-runtimes|anthropic-review-workflow)$/iu;

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

export function isUnattendedDependencyBotPullRequest(input: {
  userLogin: string | undefined;
  headRef?: string | undefined;
  action?: string | undefined;
  senderLogin?: string | undefined;
}): boolean {
  if (!input.userLogin) return false;
  if (!DEPENDENCY_BOT_LOGINS.has(input.userLogin.toLowerCase())) return false;
  if (
    input.action !== 'ready_for_review' &&
    input.senderLogin !== undefined &&
    !DEPENDENCY_BOT_LOGINS.has(input.senderLogin.toLowerCase())
  ) {
    return false;
  }
  const normalizedRef = input.headRef ?? '';
  return !QUALIFICATION_REQUIRED_RENOVATE_REF_RE.test(normalizedRef);
}

/**
 * A dependency update nobody but the bot has touched: every commit on the
 * pull request is authored by the bot and signed by GitHub. LCARS approves
 * these without a review run (CI gates the merge); the qualification branches
 * are never covered, and a commit from anyone else ends the exemption.
 *
 * Author plus GitHub's signature is the proof. GitHub signs a commit made
 * through its API or web interface only when the request carries no custom
 * author, committer or signature, so a GitHub-signed commit whose author is
 * the bot was made by the bot's own authenticated installation. Its committer
 * is GitHub's web-flow identity, never the bot, so the committer is no test.
 */
export function isVerifiedDependencyUpdate(input: {
  /** Normalized author login, e.g. `renovate[bot]`. */
  authorLogin: string | undefined;
  headRef: string | undefined;
  headOid: string;
  commits:
    | {
        totalCount: number;
        nodes: readonly {
          oid: string;
          authorLogin: string | undefined;
          signedByGitHub: boolean;
        }[];
      }
    | undefined;
}): boolean {
  const author = input.authorLogin?.toLowerCase();
  if (author === undefined || !DEPENDENCY_BOT_LOGINS.has(author)) return false;
  if (!author.endsWith('[bot]')) return false;
  if (QUALIFICATION_REQUIRED_RENOVATE_REF_RE.test(input.headRef ?? '')) {
    return false;
  }
  const commits = input.commits;
  if (commits === undefined) return false;
  if (commits.totalCount < 1 || commits.totalCount > 100) return false;
  if (commits.nodes.length !== commits.totalCount) return false;
  if (!commits.nodes.some((commit) => commit.oid === input.headOid)) {
    return false;
  }
  return commits.nodes.every(
    (commit) =>
      commit.authorLogin?.toLowerCase() === author && commit.signedByGitHub,
  );
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
  // Commit trailers (`Claude-Session:`, `Co-Authored-By: Claude`) and the
  // footer Claude Code writes into PR descriptions: a "Generated with
  // [Claude Code]" line and the session URL on a line of its own.
  if (
    /\bClaude-Session:\s*https?:\/\/claude\.ai\/code\/session_/iu.test(body) ||
    /Co-Authored-By:\s*Claude\b/iu.test(body) ||
    /Generated with \[Claude Code\]/iu.test(body) ||
    /^\s*https?:\/\/claude\.ai\/code\/session_\S+\s*$/imu.test(body)
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
 * - Codex PRs are reviewed by Claude, then Antigravity (`agy`), then Codex.
 * - Claude PRs are reviewed by Codex, then Antigravity (`agy`), then Claude.
 * - Antigravity (`agy`) PRs are reviewed by Claude, then Codex, then `agy`
 *   (Codex first when explicitly requested).
 * - If an explicit `review:<pipeline>` label names the same pipeline that
 *   authored the PR, `crossModelOverride` redirects the review to the opposite
 *   model, so an agent never reviews its own PR first.
 * - The authoring model is always the last fallback. Fallback only advances on
 *   a provider limit or cooldown, so it reviews its own PR only when every
 *   opposite model is out of quota: a same-model review beats no review.
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

  const author = input.authorPipeline;
  if (
    author !== undefined &&
    supportedSet.has(author) &&
    author !== primary &&
    !fallbackPipelines.includes(author)
  ) {
    fallbackPipelines.push(author);
  }

  return {
    pipeline: primary,
    fallbackPipelines,
    crossModelOverride,
  };
}

export interface PullRequestRemediationSelection {
  pipeline: AgentPipeline;
  fallbackPipelines: AgentPipeline[];
}

const DEFAULT_REMEDIATION_ORDER: readonly AgentPipeline[] = [
  'claude',
  'codex',
  'agy',
];

/**
 * Selects the primary coding pipeline and ordered quota-fallback pipelines
 * for remediating review comments or merge conflicts on a pull request.
 * Prefers the authoring pipeline first, then falls back across the remaining
 * supported coding providers so a single provider's quota limit never stalls
 * PR remediation or loops a human in.
 */
export function selectPullRequestRemediation(input: {
  authorPipeline?: AgentPipeline;
  preferredPipeline?: AgentPipeline;
  supportedPipelines?: readonly AgentPipeline[];
}): PullRequestRemediationSelection {
  const repoSupported = input.supportedPipelines ?? DISPATCH_PIPELINES;
  const supportedSet = new Set<AgentPipeline>(
    repoSupported.length > 0 ? repoSupported : DISPATCH_PIPELINES,
  );
  const candidates: AgentPipeline[] = [];
  for (const candidate of [
    input.preferredPipeline,
    input.authorPipeline,
    ...DEFAULT_REMEDIATION_ORDER,
  ]) {
    if (
      candidate !== undefined &&
      supportedSet.has(candidate) &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  }
  const [pipeline = 'claude', ...fallbackPipelines] = candidates;
  return { pipeline, fallbackPipelines };
}
