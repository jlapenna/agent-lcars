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

/**
 * In-memory provenance for a selected session title. This is deliberately
 * not part of the persisted SessionDoc contract.
 *
 * These are intent tiers, not data-source labels — the ranking they imply
 * (`declared` > `generated` > `inferred`, see `selectSessionTitle`) is about
 * how current each tier's signal is, not which system produced it. Claude's
 * `aiTitle` is written exactly once, early in the transcript, and never
 * revised afterward (verified against real transcripts: present in 38/40
 * recent sessions, always from the first turn) — so a session that runs long
 * and drifts keeps a stale, first-prompt-era label under `generated` for its
 * entire remaining life. The `declared` tier exists precisely because
 * nothing else in this pipeline can express "the operator says otherwise,
 * right now": it is the only channel that carries current intent, so it has
 * to outrank a machine-generated label even though nothing about being
 * hand-typed makes it more "real" than `aiTitle`. `inferred` (a first-prompt
 * fragment) is the fallback of last resort, used only when nothing more
 * intentional exists yet.
 */
export type SessionTitleSource = 'declared' | 'generated' | 'inferred';

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
  /** Which GitHub repo this session belongs to. `cli` summaries get this
   * from a per-tick `origin` remote resolution; `issue-agent` summaries
   * never set it here (they're tagged via `BuildSessionDocOptions.repo`
   * instead — see `buildSessionDoc`). */
  repo?: { owner: string; name: string };
  model?: string;
  permissionMode?: string;
  startedAt: string;
  lastActivityAt: string;
  turns: number;
  toolCallCounts: Record<string, number>;
  tokens: TokenUsage;
  lastToolCall?: ToolCallDigest;
  title?: string;
  /** In-memory only; buildSessionDoc intentionally does not persist this. */
  titleSource?: SessionTitleSource;
  /** What the agent says it is doing RIGHT NOW — `lcars session status
   * "<text>"` (issue #1257), joined onto a pristine reducer summary the same
   * way the daemon joins `title`'s declared/generated overlay (see
   * `WatcherDaemon.tick`). Unlike `title`, there is only one source (the
   * declared status annotation) and no precedence to compute: present means
   * "joined this tick", absent means "no current status annotation, clear
   * it" — see `buildSessionWrite`'s `clearFields` derivation, which reads
   * this field's absence as the entire signal. */
  status?: string;
  /** ISO timestamp from the status annotation's own `updatedAt` — when the
   * agent last said so, not when this tick happened to run. Only ever set
   * alongside `status`; the two are always joined and cleared together. */
  statusUpdatedAt?: string;
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
  /** Which GitHub repo this session belongs to. Lives on the shared base
   * (not `CliSessionDoc`/`IssueAgentSessionDoc` individually) because both
   * sources populate it, just via different routes — see
   * {@link SessionSummary.repo} (`cli`) and
   * {@link BuildSessionDocOptions.repo} (`issue-agent`). */
  repo?: { owner: string; name: string };
  startedAt: string;
  lastActivityAt: string;
  turns: number;
  toolCallCounts: Record<string, number>;
  tokens: TokenUsage;
  lastToolCall?: ToolCallDigest;
  model?: string;
  permissionMode?: string;
  title?: string;
  /** See {@link SessionSummary.status}. Rendered under the title with its
   * own age; hidden entirely once `liveness` is `ended` (a console
   * concern — see `SessionSummary.status`'s doc comment for the
   * agent-authorship story). Omitted (never written as `undefined`/`null`
   * — repo Firestore integrity rule) when no current status annotation
   * exists; a previously-written value is explicitly deleted via
   * `SessionWrite.clearFields` rather than left stale. */
  status?: string;
  /** See {@link SessionSummary.statusUpdatedAt}. */
  statusUpdatedAt?: string;
  deliverables: SessionDeliverables;
  /** ISO timestamp `lastActivityAt + CLI_SESSION_RETENTION_DAYS` (`cli`
   * docs) or `lastActivityAt + ISSUE_AGENT_SESSION_RETENTION_DAYS`
   * (`issue-agent` docs) — see `session-doc.ts` for why the two sources get
   * different retention (#3107 follow-up 2). Written as a Firestore
   * `Timestamp` (see `upsertSession`) so the `sessions` collection's TTL
   * policy can garbage-collect it — see issue #2708. Omitted when
   * `lastActivityAt` has no parseable timestamp (e.g. a transcript with no
   * timestamped lines yet). */
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
  /** The orchestrator run ID (`broker_intent_id`) — the join key from a
   * work item to its sessions. `runId` is the GitHub Actions run id. */
  intentId?: string;
  issueNumber?: number;
  /** `gs://` URI of this run's archived session data (Slice 2's runner-mode
   * shipper — see claude.yml's "Finalize telemetry sidecar" step,
   * apps/telemetry-watcher/src/lib/finalize.ts, and issue #24).
   * Issue-agent sessions
   * only: `cli` docs are built from a transcript already on local disk, so
   * there is no runner-container-destroyed-on-exit problem to solve for
   * them.
   *
   * Not necessarily a single Claude Code `.jsonl` object forever: an
   * archive-first strategy for agents with no `TranscriptAdapter` at all
   * (raw local session storage uploaded as-is under a `runs/<run-id>/<agent>/`
   * GCS *prefix*, not one file) was the intended shape for such agents as of
   * #3123 phase 2, but as of #645 no pipeline actually ships one yet —
   * OpenCode (the one agent this would currently apply to) archives nothing
   * today; see `RUNNER_CAPTURE_AGENTS` (`runner-capture.ts`) and
   * `finalize.ts`'s zero-sessions-shipped warning. Do not assume this is a
   * fetchable single transcript object without checking
   * {@link IssueAgentSessionDoc.renderable} first — that flag, not
   * `sessionAgent(doc)`, is the one the console reads. */
  transcriptGcsUri?: string;
  /**
   * Whether `transcriptGcsUri` (when set) points at a raw transcript
   * `parseTranscriptTimeline` (`transcript-timeline.ts`) can actually parse
   * into a rendered timeline — set once by `buildSessionDoc` from the
   * capturing adapter's identity (see `isRenderableTranscriptAgent`),
   * mirroring this issue's `TelemetrySessionRef` contract (agent-lcars#645):
   * captured once by Worker runtime, read — never re-derived — by the
   * console. Before this field existed, `apps/console/src/lib/
   * session-detail.ts` re-derived the same fact itself by comparing
   * `sessionAgent(doc) === 'claude-code'` directly, coincidentally matching
   * `RENDERABLE_TRANSCRIPT_AGENTS`'s current (but unrelated) contents rather
   * than reading it. Absent on docs shipped before this field existed —
   * `isSessionRenderable` (`agent.ts`) is the one place that should read
   * this with the pre-#645 fallback, never a fresh `=== 'claude-code'`
   * check re-introduced elsewhere. */
  renderable?: boolean;
}

/** Source-discriminated document shape stored at `sessions/{sessionId}`. */
export type SessionDoc = CliSessionDoc | IssueAgentSessionDoc;

export interface BuildSessionDocOptions {
  /** Host-watcher observation time for CLI liveness. */
  observedAt?: string;
  /**
   * Overrides `summary.source` when the *caller's* context is more
   * authoritative than the transcript's own self-description.
   *
   * Runner mode is the only such context: the container exists to run one
   * dispatch job, so every transcript on it is by construction an
   * `issue-agent` session. Claude's transcripts say so themselves (the
   * reducer keys off `entrypoint: 'claude-code-github-action'`), but that
   * marker is Claude-specific — Codex rollout JSONL has no equivalent, so
   * `codexAdapter` always reports `source: 'cli'`. Without this override a
   * Codex run's telemetry would land as a CLI session: no `runId`, no
   * `issueNumber`, no `repo`, and 30-day instead of 365-day retention.
   */
  forceSource?: SessionSummary['source'];
  /** `issue-agent` sessions only. */
  runId?: string;
  /** `issue-agent` sessions only. */
  intentId?: string;
  /** `issue-agent` sessions only. */
  issueNumber?: number;
  /** `issue-agent` sessions only — `cli` sessions get `repo` from
   * `summary.repo` instead (see {@link SessionSummary.repo}). */
  repo?: { owner: string; name: string };
  /** `issue-agent` sessions only. */
  transcriptGcsUri?: string;
}

/**
 * Closed union of `SessionDoc` fields a write can request DELETED from
 * Firestore rather than merely omitted (issue #1257) — `status` and
 * `statusUpdatedAt` today, always requested together (see
 * {@link buildSessionWrite}'s `clearFields` derivation in `session-doc.ts`).
 * Closed on purpose: nothing else on `SessionDoc` is deletable this way, so
 * a caller can never mistakenly request deletion of a field this contract
 * doesn't cover.
 */
export type ClearableSessionField = 'status' | 'statusUpdatedAt';

/**
 * The complete description of one Firestore write: the document to merge,
 * PLUS which fields (if any) must be explicitly deleted rather than simply
 * left out of the merge (Firestore's `set(..., {merge:true})` never removes
 * a field just because the payload omits it — an explicit
 * `FieldValue.delete()` sentinel is required, see `upsertSession` in both
 * `store.ts` modules).
 *
 * This exists so `upsertSession` takes ONE value that IS both the write and
 * the daemon's write-dedupe cache key, rather than a `doc` plus a separate
 * `clearFields` argument. The two-argument shape looks harmless but isn't:
 * a cache keyed only on the doc is narrower than the operation being
 * performed — `(doc, clearFields)` — and anything in the operation but not
 * in the key becomes a silent no-op by construction. See
 * `buildSessionWrite`'s doc comment (`session-doc.ts`) for the full
 * argument and `WatcherDaemon.tick`'s write cache for where this matters in
 * practice.
 */
export interface SessionWrite {
  readonly doc: SessionDoc;
  readonly clearFields: readonly ClearableSessionField[];
}
