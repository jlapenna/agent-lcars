export type SessionSource = 'cli' | 'issue-agent';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ToolCallDigest {
  name: string;
  timestamp: string;
}

export interface SessionDeliverables {
  branch?: string;
  prNumbers: number[];
  commitShas: string[];
}

export interface SessionSummary {
  sessionId: string;
  source: SessionSource;
  host?: string;
  cwd?: string;
  worktree?: string;
  branch?: string;
  model?: string;
  permissionMode?: string;
  startedAt: string;
  lastActivityAt: string;
  turns: number;
  toolCallCounts: Record<string, number>;
  tokens: TokenUsage;
  lastToolCall?: ToolCallDigest;
  title?: string;
  deliverables: SessionDeliverables;
}

export interface ReduceTranscriptOptions {
  /** Attached by the host watcher (not present in the transcript itself). */
  host?: string;
}

export type SessionLiveness = 'live' | 'idle' | 'ended' | 'stale';

export interface ComputeLivenessInput {
  lastActivityAt: string;
  /** Injected rather than read from the clock, for deterministic tests. */
  now: string;
  /** Whether the session's process is still alive (per a `/proc` cwd check). */
  processAlive: boolean;
  /** Whether the host watcher is sending heartbeats for this session at all. */
  heartbeatReceived: boolean;
}

interface BaseSessionDoc {
  sessionId: string;
  liveness: SessionLiveness;
  startedAt: string;
  lastActivityAt: string;
  turns: number;
  toolCallCounts: Record<string, number>;
  tokens: TokenUsage;
  lastToolCall?: ToolCallDigest;
  model?: string;
  permissionMode?: string;
  title?: string;
  deliverables: SessionDeliverables;
}

export interface CliSessionDoc extends BaseSessionDoc {
  source: 'cli';
  host?: string;
  cwd?: string;
  worktree?: string;
  branch?: string;
}

export interface IssueAgentSessionDoc extends BaseSessionDoc {
  source: 'issue-agent';
  runId?: string;
  issueNumber?: number;
}

/** Source-discriminated document shape stored at `sessions/{sessionId}`. */
export type SessionDoc = CliSessionDoc | IssueAgentSessionDoc;

export interface BuildSessionDocOptions {
  /** `issue-agent` sessions only. */
  runId?: string;
  /** `issue-agent` sessions only. */
  issueNumber?: number;
}
