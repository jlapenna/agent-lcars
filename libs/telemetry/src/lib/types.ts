export type SessionSource = 'cli' | 'issue-agent';

/**
 * Which coding agent produced a session's transcript. `'claude-code'` is the
 * only one with a working {@link TranscriptAdapter} today (see
 * `transcript-adapter.ts`) — the rest name agents phase 2/3 of #3123 are
 * expected to add adapters for, so the watcher's multi-root config
 * (apps/telemetry-watcher) and the console's badge rendering have
 * somewhere to point before those adapters exist.
 */
export type SessionAgent =
  'claude-code' | 'codex' | 'gemini' | 'antigravity' | 'opencode';

/** Every {@link SessionAgent} value, for validating config/env input against
 * the union at runtime (TypeScript unions have no runtime representation). */
export const SESSION_AGENTS: readonly SessionAgent[] = [
  'claude-code',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
];

export interface TokenUsage {
  /** Non-cached input only. Providers whose input total includes cache reads
   * must subtract `cacheReadTokens` when adapting their native usage. */
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

/**
 * Claude Code's headless result-message summary, captured from a terminal
 * `type: "result"` transcript line (issue-agent/headless `-p` runs write one
 * when the session ends). Field names/semantics mirror the signatures
 * `.github/workflows/claude.yml`'s own "Verify Claude run status" /
 * "Report failure on the issue" steps already grep out of the raw Actions
 * log (`is_error`, and the literal `subtype` value `error_max_turns` next to
 * its `--max-turns 200` budget) — reusing them here means the run-status
 * classifier's diagnoses match a heuristic already proven correct in
 * production, not a freshly-invented shape.
 */
export interface SessionResult {
  /** 'success' | 'error_max_turns' | 'error_during_execution' (Claude Code's
   * own result-message subtypes) — kept as a plain string rather than a
   * union since new subtypes are the CLI's to add, not this schema's. */
  subtype: string;
  isError: boolean;
}

export interface SessionSummary {
  sessionId: string;
  source: SessionSource;
  /** Which coding agent produced this transcript. Omitted (rather than
   * defaulted here) for any summary a pre-#3123 reducer produced or a
   * hand-built test fixture that predates this field — use the
   * {@link sessionAgent} helper to resolve the effective value (defaults to
   * `'claude-code'` when absent) instead of reading this field directly. */
  agent?: SessionAgent;
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
  /** Running total accumulated from each turn's `costUSD` field (present on
   * some transcript lines alongside `usage`), when the transcript carries
   * it — omitted rather than `0` when no line ever reported a cost, so a
   * genuinely-unmeasured session is distinguishable from a real $0 one only
   * by this field's absence, matching every other "was this present in the
   * transcript" optional field on this type. */
  totalCostUsd?: number;
  /** Present only for sessions whose transcript included a terminal
   * `type: "result"` line — see {@link SessionResult}. */
  result?: SessionResult;
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
  /** Most recent time a host watcher directly observed this CLI session.
   * Quantized by the watcher to avoid a Firestore write every tick. */
  observedAt?: string;
  /** See {@link SessionSummary.agent} — threaded through unchanged by
   * `buildSessionDoc`. Use the {@link sessionAgent} helper to resolve the
   * effective value rather than reading this field directly. */
  agent?: SessionAgent;
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
  /** ISO timestamp `lastActivityAt + CLI_SESSION_RETENTION_DAYS` (`cli`
   * docs) or `lastActivityAt + ISSUE_AGENT_SESSION_RETENTION_DAYS`
   * (`issue-agent` docs) — see `session-doc.ts` for why the two sources get
   * different retention (#3107 follow-up 2). Written as a Firestore
   * `Timestamp` (see `upsertSession`) so the `sessions` collection's TTL
   * policy (`tools/provision-agent-telemetry-gcp.sh`) can garbage-collect
   * it — see issue #2708. Omitted when `lastActivityAt` has no parseable
   * timestamp (e.g. a transcript with no timestamped lines yet). */
  expireAt?: string;
  /** See {@link SessionSummary.totalCostUsd}. */
  totalCostUsd?: number;
  /** See {@link SessionSummary.result} / {@link SessionResult}. */
  result?: SessionResult;
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
  /** `gs://` URI of this run's archived session data (Slice 2's runner-mode
   * shipper — see claude.yml's "Ship session telemetry" step and
   * infra-inventory/agent-telemetry.yaml). Issue-agent sessions
   * only: `cli` docs are built from a transcript already on local disk, so
   * there is no runner-container-destroyed-on-exit problem to solve for
   * them.
   *
   * Not always a single Claude Code `.jsonl` object: #3123 phase 2's
   * archive-first strategy for agents this repo has no `TranscriptAdapter`
   * for yet (opencode.yml's "Ship session archive" step) uploads that
   * agent's raw local session storage as-is and points this at the
   * `runs/<run-id>/<agent>/` GCS *prefix* it was archived under, not one
   * file — see `sessionAgent(doc)` on the owning doc before assuming this is
   * a fetchable single transcript object; only `'claude-code'` docs are. */
  transcriptGcsUri?: string;
}

/** Source-discriminated document shape stored at `sessions/{sessionId}`. */
export type SessionDoc = CliSessionDoc | IssueAgentSessionDoc;

export interface BuildSessionDocOptions {
  /** Host-watcher observation time for CLI liveness. */
  observedAt?: string;
  /** `issue-agent` sessions only. */
  runId?: string;
  /** `issue-agent` sessions only. */
  issueNumber?: number;
  /** `issue-agent` sessions only. */
  transcriptGcsUri?: string;
}
