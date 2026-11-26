import { execFile, spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  antigravityAdapter,
  applySessionTitleOverlay,
  claudeCodeAdapter,
  claudeSubagentSessionId,
  codexAdapter,
  isSafeIdentifier,
  opencodeAdapter,
  parseClaudeSubagentPath,
  type SessionAgent,
  type SessionEventKind,
  type SessionEventV1,
  type SessionSummary,
  totalTokens,
  type TranscriptAdapter,
} from '@agent-lcars/telemetry';

import { reduceCodexChildTranscript } from '../codex-child-transcript';
import { resolveGitBranch as defaultResolveGitBranch } from '../git-branch';
import { applyGitContext } from '../git-context';
import {
  isInsideGitCheckout,
  resolveGitRepo as defaultResolveGitRepo,
} from '../git-repo';
import { resolvePublicationCheckouts } from '../publication-checkouts';
import { readTranscriptLines as defaultReadTranscriptLines } from '../read-transcript-lines';
import {
  readSessionStatusOverlay,
  readSessionTitleOverlay,
} from '../session-title-annotation-source';
import { SESSION_STATE_DIRECTORY } from '../session-title-paths';
import { findCodexRollout } from './codex-rollout';
import { acquireFileLock, releaseFileLock } from './file-lock';
import {
  defaultHerdrPaneDependencies,
  type HerdrPaneLookup,
  resolveHerdrPane,
} from './herdr-pane';
import { loadHookClientConfig } from './hook-config';
import { appendHookLog } from './hook-log';
import {
  HOOK_EVENT_KINDS,
  type HookPayload,
  type HookRuntime,
  isHookRuntime,
  parseHookPayload,
} from './hook-payload';
import {
  hookSessionLockPath,
  type HookSessionState,
  isHookFenced,
  readHookSessionState,
  shouldShipEvent,
  writeHookSessionState,
} from './hook-state';
import {
  matchesRepoAllowlist,
  matchesWorkspaceAllowlist,
} from './repo-allowlist';
import { appendToSpool, spoolPath } from './spool';

/** Bumped when the event the client emits changes shape or semantics. */
export const HOOK_CLIENT_VERSION = '0.5.0';

export const HOOK_CLI_USAGE =
  'usage: lcars hook claude [--inline]   (reads one Claude Code hook payload on stdin)\n' +
  '       lcars hook codex  [--inline]   (reads one Codex hook payload on stdin)\n' +
  '       lcars hook opencode [--inline] (reads one payload from the OpenCode lcars-telemetry plugin on stdin)\n' +
  '       lcars hook agy [<event>] [--inline] (reads one Antigravity hook payload on stdin)\n' +
  '       lcars hook flush               (writes spooled events to the telemetry store, via lcars-hook-flush.cjs)\n' +
  '       Exits 0 and prints nothing on stdout in every case; decisions go to\n' +
  '       ~/.local/state/agent-lcars/hook.log.';

export type HookCommandAction =
  | 'usage'
  | 'ignored'
  | 'skipped-subagent'
  | 'skipped-unlisted'
  | 'throttled'
  | 'spooled'
  | 'flushed';

export interface HookCommandResult {
  readonly action: HookCommandAction;
  readonly detail?: string;
}

export interface HookCommandDependencies {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  now: () => Date;
  readStdin: () => string | Promise<string>;
  readTranscriptLines: (filePath: string) => Iterable<string>;
  fileExists: (filePath: string) => boolean;
  /** Locates a Codex rollout by session id when the payload has no path. */
  findCodexRollout: (
    codexHome: string,
    sessionId: string,
  ) => string | undefined;
  /** Resolves the checkout's repository, canonicalized against the
   * allowlist patterns passed as `watchedRepos` (see `resolveGitRepo`). */
  resolveGitRepo: (
    cwd: string,
    watchedRepos: readonly string[],
  ) => Promise<{ owner: string; name: string } | undefined>;
  resolveGitBranch: (cwd: string) => Promise<string | undefined>;
  /** True when `cwd` is inside any git checkout, resolvable or not. */
  isInsideGitCheckout: (cwd: string) => boolean;
  /** Read from the hook credential, never the transcript. Failure is unknown. */
  resolveGithubActor?: () => Promise<string | undefined>;
  resolvePublicationCheckouts?: (
    cwd: string,
  ) => Promise<{ branch: string; head: string }[] | undefined>;
  /** Finds the herdr terminal this hook runs in. Host sessions only. */
  resolveHerdrPane?: () => Promise<HerdrPaneLookup>;
  /** Starts the flusher detached from the hook process. */
  spawnFlusher: () => void;
  /** Runs the flusher to completion (`lcars hook flush`, `--inline`). */
  runFlusher: () => Promise<void>;
  randomId: () => string;
  hostname: () => string;
  stderr: (line: string) => void;
}

export function defaultHookCommandDependencies(
  env: NodeJS.ProcessEnv = process.env,
): HookCommandDependencies {
  return {
    env,
    homeDirectory: os.homedir(),
    now: () => new Date(),
    readStdin: async () => {
      if (process.stdin.isTTY) return '';
      try {
        // Runtime-spawned pipes can be nonblocking. A synchronous read may
        // throw EAGAIN before the payload or EOF arrives and lose the event.
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
      } catch {
        return '';
      }
    },
    readTranscriptLines: defaultReadTranscriptLines,
    fileExists: (filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    },
    findCodexRollout,
    resolveGitRepo: defaultResolveGitRepo,
    resolveGitBranch: defaultResolveGitBranch,
    isInsideGitCheckout,
    resolvePublicationCheckouts,
    resolveHerdrPane: () => resolveHerdrPane(defaultHerdrPaneDependencies(env)),
    resolveGithubActor: () =>
      new Promise((resolve) => {
        execFile(
          'gh',
          ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
          { env, timeout: 2000, maxBuffer: 4096, encoding: 'utf8' },
          (error, stdout) => {
            const login = stdout?.trim();
            resolve(
              !error &&
                /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/u.test(login)
                ? login
                : undefined,
            );
          },
        );
      }),
    // The flusher is its own bundle (lcars-hook-flush.cjs, installed next to
    // this one) so hook invocations never load the Firestore client: with it
    // bundled in, every hook paid ~600 ms of startup.
    spawnFlusher: () => {
      const child = spawn(process.execPath, [flusherBundlePath()], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      // An async spawn failure would otherwise be an uncaught exception.
      child.on('error', () => undefined);
      child.unref();
    },
    runFlusher: async () => {
      spawnSync(process.execPath, [flusherBundlePath()], {
        stdio: 'ignore',
        env,
        timeout: 120_000,
      });
    },
    randomId: () => crypto.randomUUID(),
    hostname: () => os.hostname(),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

type HerdrPaneState = Pick<
  HookSessionState,
  'herdrPaneId' | 'herdrForeground' | 'herdrPaneResolved' | 'herdrPaneCheckedAt'
>;

/** How long to wait before asking herdr-core again after it failed to answer. */
const HERDR_PANE_RETRY_MS = 5 * 60 * 1000;

function herdrPaneState(state: HookSessionState | undefined): HerdrPaneState {
  return {
    ...(state?.herdrPaneId && { herdrPaneId: state.herdrPaneId }),
    ...(state?.herdrPaneId &&
      state.herdrForeground && { herdrForeground: state.herdrForeground }),
    ...(state?.herdrPaneResolved && { herdrPaneResolved: true }),
    ...(state?.herdrPaneCheckedAt && {
      herdrPaneCheckedAt: state.herdrPaneCheckedAt,
    }),
  };
}

/**
 * Asks herdr-core which terminal this session runs in, when this event
 * should ask at all. `undefined` means it did not ask.
 *
 * A session start asks again, because a resumed session can be in another
 * terminal. Every other event reuses a definite earlier answer, and waits
 * out {@link HERDR_PANE_RETRY_MS} after a failed one. A dispatched runner
 * never runs in a herdr-core terminal, and a throttled event ships nothing.
 */
async function lookupHerdrPane(
  deps: HookCommandDependencies,
  runner: unknown,
  kind: SessionEventKind,
  state: HookSessionState | undefined,
  now: string,
): Promise<HerdrPaneLookup | undefined> {
  if (runner || !deps.resolveHerdrPane) return undefined;
  if (kind !== 'start') {
    if (state?.herdrPaneResolved || !shouldShipEvent(kind, state, now)) {
      return undefined;
    }
    const sinceFailure = state?.herdrPaneCheckedAt
      ? Date.parse(now) - Date.parse(state.herdrPaneCheckedAt)
      : Number.POSITIVE_INFINITY;
    if (sinceFailure >= 0 && sinceFailure < HERDR_PANE_RETRY_MS) {
      return undefined;
    }
  }
  return deps
    .resolveHerdrPane()
    .catch((): HerdrPaneLookup => ({ status: 'unknown' }));
}

/**
 * What to report and remember after {@link lookupHerdrPane}.
 *
 * When herdr-core could not answer, the pane known before is still
 * reported, but it is no longer a definite answer: later events ask again
 * once {@link HERDR_PANE_RETRY_MS} has passed. That matters most on a
 * session start, which asks because the session may have moved.
 *
 * The lookup ran before the session lock, on the state read then. If
 * another event of this session settled the answer in the meantime, a
 * failed lookup from an ordinary event does not unsettle it.
 */
function applyHerdrPaneLookup(
  state: HookSessionState | undefined,
  lookup: HerdrPaneLookup | undefined,
  kind: SessionEventKind,
  now: string,
): HerdrPaneState {
  const known = herdrPaneState(state);
  if (!lookup) return known;
  if (lookup.status === 'unknown') {
    if (kind !== 'start' && known.herdrPaneResolved) return known;
    return {
      ...(known.herdrPaneId && { herdrPaneId: known.herdrPaneId }),
      ...(known.herdrForeground && { herdrForeground: known.herdrForeground }),
      herdrPaneCheckedAt: now,
    };
  }
  return {
    ...(lookup.status === 'found' && { herdrPaneId: lookup.paneId }),
    ...(lookup.status === 'found' &&
      lookup.foreground && { herdrForeground: lookup.foreground }),
    herdrPaneResolved: true,
  };
}

interface RuntimeProfile {
  readonly agent: SessionAgent;
  readonly adapter: TranscriptAdapter;
}

const RUNTIME_PROFILES: Readonly<Record<HookRuntime, RuntimeProfile>> = {
  claude: { agent: 'claude-code', adapter: claudeCodeAdapter },
  codex: { agent: 'codex', adapter: codexAdapter },
  // The OpenCode plugin (agents/opencode/lcars-telemetry/) supplies an
  // export-shaped snapshot as transcript_path; the same reducer that reads
  // `opencode session export` output summarizes it.
  opencode: { agent: 'opencode', adapter: opencodeAdapter },
  agy: { agent: 'antigravity', adapter: antigravityAdapter },
};

/** `lcars-hook-flush.cjs` beside the running bundle (`process.argv[1]`). */
export function flusherBundlePath(entry = process.argv[1] ?? ''): string {
  return path.join(path.dirname(entry), FLUSHER_BUNDLE);
}

export const FLUSHER_BUNDLE = 'lcars-hook-flush.cjs';

function stateDirectoryFor(deps: HookCommandDependencies): string {
  return path.join(deps.homeDirectory, SESSION_STATE_DIRECTORY);
}

function zeroSummary(
  agent: SessionAgent,
  sessionId: string,
  now: string,
  payload: HookPayload,
): SessionSummary {
  return {
    sessionId,
    source: 'cli',
    agent,
    startedAt: now,
    lastActivityAt: now,
    turns: 0,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...(payload.cwd && { cwd: payload.cwd }),
    ...(payload.model && { model: payload.model }),
  };
}

function resolveTranscriptPath(
  deps: HookCommandDependencies,
  runtime: HookRuntime,
  payload: HookPayload,
): string | undefined {
  if (payload.transcriptPath && deps.fileExists(payload.transcriptPath)) {
    return payload.transcriptPath;
  }
  if (runtime !== 'codex') return undefined;
  const codexHome =
    deps.env['CODEX_HOME'] ?? path.join(deps.homeDirectory, '.codex');
  return deps.findCodexRollout(codexHome, payload.sessionId);
}

function reduceTranscript(
  deps: HookCommandDependencies,
  adapter: TranscriptAdapter,
  transcriptPath: string | undefined,
  sessionId: string,
): SessionSummary | undefined {
  if (!transcriptPath) return undefined;
  try {
    const summaries = adapter.reduce(
      deps.readTranscriptLines(transcriptPath),
      transcriptPath,
    );
    return (
      summaries.find((summary) => summary.sessionId === sessionId) ??
      summaries[0]
    );
  } catch {
    return undefined;
  }
}

/**
 * Resolves the child JSONL path for a Claude Code `SubagentStop` hook.
 * Prefers `agent_transcript_path` when supplied; otherwise derives the
 * canonical `<projectDir>/<parentId>/subagents/agent-<agentId>.jsonl` sibling
 * when `transcript_path` names `<projectDir>/<parentId>.jsonl`. Never falls
 * back to the parent's own transcript.
 */
function resolveClaudeChildTranscriptPath(
  payload: HookPayload,
): string | undefined {
  if (payload.agentTranscriptPath) {
    const parsed = parseClaudeSubagentPath(payload.agentTranscriptPath);
    return parsed &&
      parsed.parentSessionId === payload.sessionId &&
      parsed.agentId === payload.agentId
      ? payload.agentTranscriptPath
      : undefined;
  }
  if (
    !payload.transcriptPath ||
    !payload.agentId ||
    path.basename(payload.transcriptPath) !== `${payload.sessionId}.jsonl`
  ) {
    return undefined;
  }
  return path.join(
    path.dirname(payload.transcriptPath),
    payload.sessionId,
    'subagents',
    `agent-${payload.agentId}.jsonl`,
  );
}

/**
 * Reduces a verified standalone Claude Code `Agent` subagent transcript.
 * Requires the path to match `<parentId>/subagents/agent-<agentId>.jsonl`,
 * every JSONL record to carry `sessionId === parentId`, `agentId`, and
 * `isSidechain: true`, and at least one observed turn or token count so an
 * empty or mismatched file never produces a synthetic child session.
 */
function reduceClaudeChildTranscript(
  deps: HookCommandDependencies,
  transcriptPath: string | undefined,
  childSessionId: string,
  expectedParentId: string | undefined,
  expectedAgentId: string | undefined,
): SessionSummary | undefined {
  if (!transcriptPath || !expectedParentId || !expectedAgentId) {
    return undefined;
  }
  const parsedPath = parseClaudeSubagentPath(transcriptPath);
  if (
    !parsedPath ||
    parsedPath.parentSessionId !== expectedParentId ||
    parsedPath.agentId !== expectedAgentId ||
    parsedPath.sessionId !== childSessionId
  ) {
    return undefined;
  }
  try {
    const summary = claudeCodeAdapter.reduce(
      deps.readTranscriptLines(transcriptPath),
      transcriptPath,
    )[0];
    return summary?.sessionId === childSessionId &&
      (summary.turns > 0 || totalTokens(summary.tokens) > 0)
      ? summary
      : undefined;
  } catch {
    return undefined;
  }
}

function applyAnnotationOverlays(
  stateDirectory: string,
  summary: SessionSummary,
): SessionSummary {
  const titles = readSessionTitleOverlay(stateDirectory, [summary.sessionId]);
  const overlaid = applySessionTitleOverlay(summary, {
    declared: titles.declared.annotations.get(summary.sessionId),
  });
  const statuses = readSessionStatusOverlay(stateDirectory, [
    summary.sessionId,
  ]);
  const status = statuses.annotations.get(summary.sessionId);
  return status
    ? { ...overlaid, status: status.status, statusUpdatedAt: status.updatedAt }
    : overlaid;
}

/** The private directory the OpenCode plugin wrote this payload's snapshot
 *  into (`<tmpdir>/lcars-opencode-XXXXXX/export.json`), or undefined. Only that
 *  exact shape is ever deleted. */
export function opencodeSnapshotDirectory(
  rawPayload: string,
  tempRoot = os.tmpdir(),
): string | undefined {
  let transcriptPath: unknown;
  try {
    transcriptPath = (JSON.parse(rawPayload) as Record<string, unknown>)[
      'transcript_path'
    ];
  } catch {
    return undefined;
  }
  if (typeof transcriptPath !== 'string') return undefined;
  const resolved = path.resolve(transcriptPath);
  const directory = path.dirname(resolved);
  return path.basename(resolved) === 'export.json' &&
    path.dirname(directory) === path.resolve(tempRoot) &&
    /^lcars-opencode-[A-Za-z0-9]{6}$/u.test(path.basename(directory))
    ? directory
    : undefined;
}

/** The plugin hands its snapshot to this detached process, which deletes it
 *  whatever the outcome; the snapshot holds message bodies. */
async function handleOpencodeHook(
  deps: HookCommandDependencies,
  inline: boolean,
): Promise<HookCommandResult> {
  let snapshotDirectory: string | undefined;
  const readStdin = async () => {
    const raw = await deps.readStdin();
    snapshotDirectory = opencodeSnapshotDirectory(raw);
    return raw;
  };
  try {
    return await handleRuntimeHook({ ...deps, readStdin }, 'opencode', inline);
  } finally {
    if (snapshotDirectory) {
      fs.rmSync(snapshotDirectory, { recursive: true, force: true });
    }
  }
}

async function handleRuntimeHook(
  deps: HookCommandDependencies,
  runtime: HookRuntime,
  inline: boolean,
  fallbackEventName?: string,
): Promise<HookCommandResult> {
  const profile = RUNTIME_PROFILES[runtime];
  const stateDirectory = stateDirectoryFor(deps);
  const now = deps.now().toISOString();
  const log = (action: string, detail = '') =>
    appendHookLog(
      stateDirectory,
      `${now} ${runtime} ${action} ${detail}`.trimEnd(),
    );

  let payload = parseHookPayload(await deps.readStdin(), fallbackEventName);
  if (!payload) {
    log('ignored', 'unparseable payload');
    return { action: 'ignored', detail: 'unparseable payload' };
  }
  const kind: SessionEventKind | undefined =
    (runtime === 'codex' || runtime === 'claude') &&
    payload.hookEventName === 'SubagentStop'
      ? 'stop'
      : HOOK_EVENT_KINDS[payload.hookEventName];
  if (!kind) {
    log('ignored', `event=${payload.hookEventName}`);
    return { action: 'ignored', detail: payload.hookEventName };
  }
  if (payload.hookEventName === 'SubagentStop' && !payload.isSubagent) {
    log('ignored', 'missing child identity');
    return { action: 'ignored', detail: 'missing child identity' };
  }
  let codexParentId: string | undefined;
  let claudeSubagent:
    { parentId: string; agentId: string; childSessionId: string } | undefined;
  if (payload.isSubagent) {
    const initialPayload = payload;
    const skipSubagent = () => {
      // Name the identities (when safe to print) so a skipped event can be
      // matched to a session instead of only to a timestamp.
      const tag = (id: string | undefined) =>
        id && isSafeIdentifier(id) ? id.slice(0, 8) : 'unsafe';
      log(
        'skipped-subagent',
        `parent=${tag(initialPayload.sessionId)} child=${tag(initialPayload.agentId)} event=${initialPayload.hookEventName}`,
      );
      return { action: 'skipped-subagent' as const };
    };
    if (runtime === 'codex') {
      if (
        !payload.agentId ||
        !isSafeIdentifier(payload.agentId) ||
        !isSafeIdentifier(payload.sessionId) ||
        payload.agentId === payload.sessionId
      ) {
        return skipSubagent();
      }
      // Codex hook session_id identifies the parent. Use only the explicit child
      // path or exact agent_id rollout lookup; the common transcript is parent-owned.
      codexParentId = payload.sessionId;
      payload = {
        ...payload,
        sessionId: payload.agentId,
        transcriptPath: payload.agentTranscriptPath,
      };
    } else if (
      runtime === 'claude' &&
      payload.hookEventName === 'SubagentStop'
    ) {
      const childSessionId = payload.agentId
        ? claudeSubagentSessionId(payload.sessionId, payload.agentId)
        : undefined;
      if (!childSessionId || !payload.agentId) {
        return skipSubagent();
      }
      claudeSubagent = {
        parentId: payload.sessionId,
        agentId: payload.agentId,
        childSessionId,
      };
      payload = {
        ...payload,
        sessionId: childSessionId,
        transcriptPath: resolveClaudeChildTranscriptPath(payload),
      };
    } else {
      return skipSubagent();
    }
  }
  if (!isSafeIdentifier(payload.sessionId)) {
    log('ignored', 'unsafe session id');
    return { action: 'ignored', detail: 'unsafe session id' };
  }
  const sessionTag = payload.sessionId.slice(0, 8);

  const config = loadHookClientConfig({
    homeDirectory: deps.homeDirectory,
    env: deps.env,
    hostname: deps.hostname,
  });

  let repo: { owner: string; name: string } | undefined;
  if (config.runner) {
    repo = config.runner.repo;
  } else {
    repo = payload.cwd
      ? await deps.resolveGitRepo(payload.cwd, config.repos)
      : undefined;
    // A session outside every checkout (one started in `~/p`, say) has no
    // repository to allowlist; a configured workspace root admits it.
    const admitted = repo
      ? matchesRepoAllowlist(repo, config.repos)
      : payload.cwd !== undefined &&
        matchesWorkspaceAllowlist(payload.cwd, config.workspaces) &&
        !deps.isInsideGitCheckout(payload.cwd);
    if (!admitted) {
      log(
        'skipped-unlisted',
        `session=${sessionTag} event=${payload.hookEventName}`,
      );
      return { action: 'skipped-unlisted' };
    }
  }

  // The terminal lookup runs herdr-core, so it happens before the session
  // lock: a slow answer must not make the events queued behind this one give
  // up on the lock. The state it reads here only decides whether to ask; the
  // answer is merged into the state read under the lock.
  const herdrPaneLookup = await lookupHerdrPane(
    deps,
    config.runner,
    kind,
    readHookSessionState(stateDirectory, payload.sessionId),
    now,
  );

  // Async hooks (PostToolUse, Stop, SessionEnd) can overlap; the per-session
  // lock makes read-state → append → write-state atomic so no two events
  // share a `seq` and the spool order matches the sequence order.
  const lockPath = hookSessionLockPath(stateDirectory, payload.sessionId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (!(await acquireFileLock(lockPath, { waitMs: 5_000, staleMs: 30_000 }))) {
    log('ignored', `session=${sessionTag} lock busy`);
    return { action: 'ignored', detail: 'lock busy' };
  }
  let lockHeld = true;
  try {
    if (isHookFenced(stateDirectory)) {
      log('fenced', `session=${sessionTag} event=${payload.hookEventName}`);
      return { action: 'ignored', detail: 'fenced' };
    }
    const state = readHookSessionState(stateDirectory, payload.sessionId);
    if (!config.runner && !repo && state?.repoScoped) {
      log(
        'skipped-unlisted',
        `session=${sessionTag} event=${payload.hookEventName} repo-scoped`,
      );
      return { action: 'skipped-unlisted' };
    }
    if (!shouldShipEvent(kind, state, now)) {
      writeHookSessionState(stateDirectory, {
        version: 1,
        sessionId: payload.sessionId,
        seq: state?.seq ?? 0,
        ...(state?.lastShippedAt && { lastShippedAt: state.lastShippedAt }),
        ...(state?.lastKind && { lastKind: state.lastKind }),
        ...(state?.repoScoped && { repoScoped: true }),
        ...herdrPaneState(state),
        updatedAt: now,
      });
      log('throttled', `session=${sessionTag}`);
      return { action: 'throttled' };
    }

    const transcriptPath = resolveTranscriptPath(deps, runtime, payload);
    const reduced = payload.isSubagent
      ? claudeSubagent
        ? reduceClaudeChildTranscript(
            deps,
            transcriptPath,
            claudeSubagent.childSessionId,
            claudeSubagent.parentId,
            claudeSubagent.agentId,
          )
        : reduceCodexChildTranscript(
            () =>
              transcriptPath ? deps.readTranscriptLines(transcriptPath) : [],
            payload.sessionId,
            codexParentId,
          )
      : reduceTranscript(
          deps,
          profile.adapter,
          transcriptPath,
          payload.sessionId,
        );
    if (payload.isSubagent && !reduced) {
      log(
        'skipped-subagent',
        `session=${sessionTag} unverified child transcript`,
      );
      return {
        action: 'skipped-subagent',
        detail: 'unverified child transcript',
      };
    }
    const herdrPane = applyHerdrPaneLookup(state, herdrPaneLookup, kind, now);
    let summary: SessionSummary | undefined;
    if (reduced || kind !== 'end') {
      const base =
        reduced ?? zeroSummary(profile.agent, payload.sessionId, now, payload);
      const withHost: SessionSummary = {
        ...base,
        sessionId: payload.sessionId,
        agent: profile.agent,
        host: config.host,
        ...(payload.cwd && { cwd: payload.cwd }),
        ...(base.model === undefined &&
          payload.model && { model: payload.model }),
        repo,
      };
      // Branch evidence must be observed from the hook checkout. Never keep a
      // reducer-supplied branch when git resolution fails.
      delete withHost.branch;
      // The terminal is observed from the hook's own process, never read
      // from the transcript.
      delete withHost.herdrPaneId;
      if (herdrPane.herdrPaneId) withHost.herdrPaneId = herdrPane.herdrPaneId;
      const withGit = await applyGitContext(
        withHost,
        deps.resolveGitBranch,
        async () => repo,
      );
      // The reducer is deliberately unable to supply this identity. A missing
      // token, failed API read or unsupported installation token stays unknown.
      const githubActor =
        !config.runner &&
        profile.agent === 'claude-code' &&
        payload.cwd &&
        withGit.branch
          ? await deps.resolveGithubActor?.().catch(() => undefined)
          : undefined;
      delete withGit.githubActor;
      // The transcript's worktree may lie inside a checkout this session
      // left; with no checkout of its own a host-scoped session keeps none.
      if (!repo) delete withGit.worktree;
      // A reducer can supply provider identity, never host checkout facts.
      const deliverables = { ...withGit.deliverables };
      delete deliverables.publicationCheckouts;
      // A workspace-admitted session has no checkout that vouches for what
      // its transcript names. Keep only PRs in allowlisted repositories and
      // drop the evidence that names no repository at all.
      if (!repo) {
        const listed = <T extends { repo: { owner: string; name: string } }>(
          prs: T[],
        ) => prs.filter((pr) => matchesRepoAllowlist(pr.repo, config.repos));
        deliverables.prNumbers = [];
        deliverables.commitShas = [];
        delete deliverables.branch;
        if (deliverables.qualifiedPRs)
          deliverables.qualifiedPRs = listed(deliverables.qualifiedPRs);
        if (deliverables.publicationCandidates)
          deliverables.publicationCandidates = listed(
            deliverables.publicationCandidates,
          );
      }
      const checkouts =
        githubActor &&
        payload.cwd &&
        !config.runner &&
        deliverables.claudeSessionId &&
        deliverables.publicationCandidates?.length
          ? await deps
              .resolvePublicationCheckouts?.(payload.cwd)
              .catch(() => undefined)
          : undefined;
      if (checkouts && githubActor && repo)
        deliverables.publicationCheckouts = checkouts.map((checkout) => ({
          ...checkout,
          repo,
          githubActor,
          observedAt: now,
        }));
      summary = applyAnnotationOverlays(stateDirectory, {
        ...withGit,
        deliverables,
        ...(githubActor && { githubActor }),
      });
    }

    const seq = (state?.seq ?? 0) + 1;
    const event: SessionEventV1 = {
      version: 1,
      eventId: deps.randomId(),
      seq,
      occurredAt: now,
      host: config.host,
      agent: profile.agent,
      sessionId: payload.sessionId,
      kind,
      runtime: {
        name: profile.agent,
        hookEvent: payload.hookEventName,
        clientVersion: HOOK_CLIENT_VERSION,
      },
      ...(summary && { summary }),
      ...(config.runner && { runner: config.runner }),
    };
    appendToSpool(spoolPath(stateDirectory), event);
    writeHookSessionState(stateDirectory, {
      version: 1,
      sessionId: payload.sessionId,
      seq,
      lastShippedAt: now,
      lastKind: kind,
      ...((repo || state?.repoScoped) && { repoScoped: true }),
      ...herdrPane,
      updatedAt: now,
    });
    log('spooled', `session=${sessionTag} kind=${kind} seq=${seq}`);
    // The flusher marks delivery under this same lock; release it first so
    // an inline flush cannot wait on its own hook.
    releaseFileLock(lockPath);
    lockHeld = false;
    if (inline) {
      await deps.runFlusher();
    } else if (config.writer) {
      // Spool-only clients have no destination for an automatic flush.
      try {
        deps.spawnFlusher();
      } catch {
        log('flusher-spawn-failed');
      }
    }
    return { action: 'spooled', detail: `${kind} seq=${seq}` };
  } finally {
    if (lockHeld) releaseFileLock(lockPath);
  }
}

/**
 * `lcars hook ...` entry point. Never throws, never writes to stdout (a
 * `SessionStart` hook's stdout is injected into the agent's context), and
 * the caller always exits 0: telemetry must never fail or slow an agent.
 */
export async function executeHookCommand(
  argv: readonly string[],
  deps: HookCommandDependencies,
): Promise<HookCommandResult> {
  const [subcommand, ...rest] = argv;
  try {
    if (isHookRuntime(subcommand)) {
      const inline = rest.includes('--inline');
      const fallbackEventName = rest.find((arg) => !arg.startsWith('--'));
      return subcommand === 'opencode'
        ? await handleOpencodeHook(deps, inline)
        : await handleRuntimeHook(deps, subcommand, inline, fallbackEventName);
    }
    if (subcommand === 'flush') {
      await deps.runFlusher();
      return { action: 'flushed' };
    }
    deps.stderr(HOOK_CLI_USAGE);
    return { action: 'usage' };
  } catch (error) {
    appendHookLog(
      stateDirectoryFor(deps),
      `${deps.now().toISOString()} ${subcommand ?? ''} crashed ${(error as Error).message}`,
    );
    return { action: 'ignored', detail: 'crashed' };
  }
}
