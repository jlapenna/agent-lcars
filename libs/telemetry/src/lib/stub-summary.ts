import {
  SessionAgent,
  SessionDeliverables,
  SessionSummary,
  TokenUsage,
} from './types';

const EMPTY_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const EMPTY_DELIVERABLES: SessionDeliverables = {
  prNumbers: [],
  commitShas: [],
};

export interface BuildStubSummaryOptions {
  sessionId: string;
  agent: SessionAgent;
  startedAt: string;
  lastActivityAt: string;
  title?: string;
}

/**
 * Builds a minimal `SessionSummary` for an agent pipeline whose transcript
 * format this repo does not parse yet (archive-first session shipping,
 * #3123 phase 2 — see `TranscriptAdapter` in `transcript-adapter.ts` for the
 * seam a future adapter fills in). Zero turns/tokens, empty
 * toolCallCounts/deliverables — this is a placeholder identity record, not a
 * real reduction of any transcript content, so it carries only what the
 * shipping step actually knows about the run: session id, which agent
 * produced it, and when it started/last touched anything.
 *
 * `source` is always `'issue-agent'`: a stub only ever stands in for a
 * runner-mode session whose real archive lives in GCS (see
 * `infra-inventory/agent-telemetry.yaml`'s object layout) — there
 * is no local-CLI use case for a summary this empty, since a CLI session
 * always has a real transcript on disk to reduce instead.
 */
export function buildStubSummary(
  options: BuildStubSummaryOptions,
): SessionSummary {
  return {
    sessionId: options.sessionId,
    source: 'issue-agent',
    agent: options.agent,
    startedAt: options.startedAt,
    lastActivityAt: options.lastActivityAt,
    turns: 0,
    toolCallCounts: {},
    tokens: EMPTY_TOKENS,
    deliverables: EMPTY_DELIVERABLES,
    ...(options.title && { title: options.title }),
  };
}
