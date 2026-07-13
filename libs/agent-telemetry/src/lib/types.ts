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
  /** Filenames the share-media hook has written under this session's share
   * dir on its host (see `discoverSessionArtifacts` in the watcher). */
  artifacts?: string[];
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
  /** ISO timestamp `lastActivityAt + SESSION_RETENTION_DAYS`. Written as a
   * Firestore `Timestamp` (see `upsertSession`) so the `sessions` collection's
   * TTL policy (`tools/provision-agent-telemetry-gcp.sh`) can garbage-collect
   * it — see issue #2708. */
  expireAt: string;
}

export interface CliSessionDoc extends BaseSessionDoc {
  source: 'cli';
  host?: string;
  cwd?: string;
  worktree?: string;
  branch?: string;
  /** Host-scoped, like `cwd`/`branch` - issue-agent (runner) sessions have
   * no artifact story yet, so this only ever appears on `cli` docs. */
  artifacts?: string[];
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
