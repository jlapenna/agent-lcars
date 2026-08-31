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

export function isSessionAgent(value: unknown): value is SessionAgent {
  return SESSION_AGENTS.includes(value as SessionAgent);
}

export interface SessionRepository {
  owner: string;
  name: string;
}

/** GitHub permits a 39-character owner and a 100-character repository name.
 * Keep this validation next to the persisted document contract so writers and
 * readers cannot disagree about what a repository identity means. */
const GITHUB_OWNER_MAX_LENGTH = 39;
const GITHUB_REPOSITORY_NAME_MAX_LENGTH = 100;
const GITHUB_REPOSITORY_COMPONENT_RE = /^[\w.-]+$/u;

export function isCanonicalSessionRepository(
  value: unknown,
): value is SessionRepository {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { owner, name } = value as Record<string, unknown>;
  return (
    typeof owner === 'string' &&
    owner.length > 0 &&
    owner.length <= GITHUB_OWNER_MAX_LENGTH &&
    GITHUB_REPOSITORY_COMPONENT_RE.test(owner) &&
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= GITHUB_REPOSITORY_NAME_MAX_LENGTH &&
    GITHUB_REPOSITORY_COMPONENT_RE.test(name)
  );
}

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
 * when the session ends). Its `is_error` and `error_max_turns` values are
 * the CLI's own result contract, which lets the run-status classifier use
 * the same concrete evidence as the QueueExecutor runtime.
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
  /** Which coding agent produced this transcript. Current adapters stamp
   * this before a summary reaches the persisted-session writer. */
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
  /** The adapter identity written by the current watcher/reducer. */
  agent: SessionAgent;
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
  /** A host-scoped CLI session is valid without a GitHub repository. When a
   * repository is present it must be canonical; readers never guess one. */
  repo?: SessionRepository;
  host?: string;
  cwd?: string;
  worktree?: string;
  branch?: string;
  /** Host-scoped, like `cwd`/`branch` - issue-agent (runner) sessions have
   * no artifact story yet, so this only ever appears on `cli` docs. */
  artifacts?: string[];
}

interface IssueAgentSessionDocBase extends BaseSessionDoc {
  source: 'issue-agent';
  /** A QueueExecutor session is a GitHub-work anchor, so its repository is
   * never optional. */
  repo: SessionRepository;
  runId?: string;
  /** The QueueExecutor attempt ID — the join key from a work item to its
   * sessions. `runId` identifies the claimed execution. */
  intentId?: string;
  issueNumber?: number;
  /** `gs://` URI of this run's archived session data (Slice 2's runner-mode
   * shipper — see `apps/telemetry-watcher/src/lib/finalize.ts` and issue
   * #24).
   * Issue-agent sessions
   * only: `cli` docs are built from a transcript already on local disk, so
   * there is no runner-container-destroyed-on-exit problem to solve for
   * them.
   *
   * OpenCode's SQLite-backed store is materialized through the CLI's export
   * contract into one JSONL object per session before upload, while Claude
   * Code and Codex already write per-session files. Do not assume an archived
   * object is console-renderable without checking
   * {@link IssueAgentSessionDoc.renderable} first — OpenCode archives are
   * durable but intentionally remain summary-only in the console. */
}

/** An archived issue-agent transcript carries the capture-time renderability
 * decision. It is never inferred from the provider at read time. */
export interface ArchivedIssueAgentSessionDoc extends IssueAgentSessionDocBase {
  transcriptGcsUri: string;
  renderable: boolean;
}

/** Summary-only issue-agent records have no transcript capability to state. */
export interface SummaryIssueAgentSessionDoc extends IssueAgentSessionDocBase {
  transcriptGcsUri?: undefined;
  renderable?: undefined;
}

export type IssueAgentSessionDoc =
  ArchivedIssueAgentSessionDoc | SummaryIssueAgentSessionDoc;

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
   * `issue-agent` session. Providers do not share a transcript provenance
   * marker, so the runtime supplies this authoritative context. Without
   * this override, a provider transcript would land as a CLI session: no
   * `runId`, no `issueNumber`, no `repo`, and 30-day instead of 365-day
   * retention.
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
