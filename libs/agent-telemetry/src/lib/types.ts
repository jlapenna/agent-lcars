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
