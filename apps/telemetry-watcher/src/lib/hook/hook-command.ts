import { execFile, spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applySessionTitleOverlay,
  claudeCodeAdapter,
  codexAdapter,
  isSafeIdentifier,
  opencodeAdapter,
  type SessionAgent,
  type SessionEventKind,
  type SessionEventV1,
  type SessionSummary,
  type TranscriptAdapter,
} from '@agent-lcars/telemetry';

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
  readStdin: () => string;
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
    readStdin: () => {
      if (process.stdin.isTTY) return '';
      try {
        return fs.readFileSync(0, 'utf8');
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

interface RuntimeProfile {
  readonly agent: SessionAgent;
  readonly adapter: TranscriptAdapter;
}

const RUNTIME_PROFILES: Readonly<Record<HookRuntime, RuntimeProfile>> = {
  claude: { agent: 'claude-code', adapter: claudeCodeAdapter },
  codex: { agent: 'codex', adapter: codexAdapter },
  // The OpenCode plugin (agents/opencode/lcars-telemetry.js) supplies an
  // export-shaped snapshot as transcript_path; the same reducer that reads
  // `opencode export` output summarizes it.
  opencode: { agent: 'opencode', adapter: opencodeAdapter },
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
    const summaries = adapter.reduce(deps.readTranscriptLines(transcriptPath));
    return (
      summaries.find((summary) => summary.sessionId === sessionId) ??
      summaries[0]
    );
  } catch {
    return undefined;
  }
}

/** Codex fork rollouts can carry the parent's metadata and history before
 * their own thread begins. Independent children start at their own metadata;
 * forks start at the identity-matched child suffix. Only explicit child
 * thread counters belong to the child's summary. Missing or
 * ambiguous ownership remains uncollected rather than billed as a new session. */
function reduceCodexChildTranscript(
  deps: HookCommandDependencies,
  transcriptPath: string | undefined,
  sessionId: string,
  expectedParentId: string | undefined,
): SessionSummary | undefined {
  if (!transcriptPath || !expectedParentId) return undefined;
  try {
    const ownedLines: string[] = [];
    let parentId: string | undefined;
    let ownThread = false;
    let usage: SessionSummary['tokens'] | undefined;
    let inclusiveInput = 0;
    for (const line of deps.readTranscriptLines(transcriptPath)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          id?: unknown;
          type?: unknown;
          thread_id?: unknown;
          forked_from_id?: unknown;
          source?: {
            subagent?: { thread_spawn?: { parent_thread_id?: unknown } };
          };
          thread_token_usage?: {
            input_tokens?: unknown;
            output_tokens?: unknown;
            cached_input_tokens?: unknown;
          };
        };
      };
      const payload = row?.payload;
      if (!parentId) {
        const parent =
          payload?.source?.subagent?.thread_spawn?.parent_thread_id;
        if (
          row?.type !== 'session_meta' ||
          payload?.id !== sessionId ||
          typeof parent !== 'string' ||
          !isSafeIdentifier(parent) ||
          parent === sessionId ||
          parent !== expectedParentId ||
          (payload?.forked_from_id !== undefined &&
            payload.forked_from_id !== parent)
        )
          return undefined;
        parentId = parent;
        // A child spawned without inherited history has no fork marker or
        // initial thread_settings_applied event. Its exact session metadata
        // starts ownership; any later foreign metadata still fails closed.
        ownThread = payload.forked_from_id === undefined;
        ownedLines.push(line);
        continue;
      }
      if (!ownThread) {
        if (row?.type === 'session_meta' && payload?.id !== parentId)
          return undefined;
        if (
          row?.type !== 'event_msg' ||
          payload?.type !== 'thread_settings_applied' ||
          payload?.thread_id !== sessionId
        )
          continue;
        ownThread = true;
      }
      if (row?.type === 'session_meta' && payload?.id !== sessionId)
        return undefined;
      if (
        row?.type === 'event_msg' &&
        payload?.type === 'thread_settings_applied' &&
        payload.thread_id !== sessionId
      )
        return undefined;
      if (row?.type === 'token_usage_record') {
        if (payload?.thread_id !== sessionId) return undefined;
        const total = payload?.thread_token_usage;
        const input = total?.input_tokens;
        const output = total?.output_tokens;
        const cached = total?.cached_input_tokens;
        if (
          typeof input !== 'number' ||
          typeof output !== 'number' ||
          typeof cached !== 'number' ||
          [input, output, cached].some(
            (value) => !Number.isSafeInteger(value) || value < 0,
          ) ||
          cached > input ||
          input < inclusiveInput ||
          output < (usage?.outputTokens ?? 0) ||
          cached < (usage?.cacheReadTokens ?? 0)
        )
          return undefined;
        inclusiveInput = input;
        usage = {
          inputTokens: input - cached,
          outputTokens: output,
          cacheReadTokens: cached,
          cacheCreationTokens: 0,
        };
      }
      ownedLines.push(line);
    }
    if (!ownThread || !usage) return undefined;
    const summary = codexAdapter.reduce(ownedLines)[0];
    return summary?.sessionId === sessionId
      ? { ...summary, tokens: usage }
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
  const readStdin = () => {
    const raw = deps.readStdin();
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
): Promise<HookCommandResult> {
  const profile = RUNTIME_PROFILES[runtime];
  const stateDirectory = stateDirectoryFor(deps);
  const now = deps.now().toISOString();
  const log = (action: string, detail = '') =>
    appendHookLog(
      stateDirectory,
      `${now} ${runtime} ${action} ${detail}`.trimEnd(),
    );

  let payload = parseHookPayload(deps.readStdin());
  if (!payload) {
    log('ignored', 'unparseable payload');
    return { action: 'ignored', detail: 'unparseable payload' };
  }
  const kind: SessionEventKind | undefined =
    runtime === 'codex' && payload.hookEventName === 'SubagentStop'
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
  if (payload.isSubagent) {
    if (
      runtime !== 'codex' ||
      !payload.agentId ||
      !isSafeIdentifier(payload.agentId) ||
      !isSafeIdentifier(payload.sessionId) ||
      payload.agentId === payload.sessionId
    ) {
      // Name the identities (when safe to print) so a skipped event can be
      // matched to a session instead of only to a timestamp.
      const tag = (id: string | undefined) =>
        id && isSafeIdentifier(id) ? id.slice(0, 8) : 'unsafe';
      log(
        'skipped-subagent',
        `parent=${tag(payload.sessionId)} child=${tag(payload.agentId)} event=${payload.hookEventName}`,
      );
      return { action: 'skipped-subagent' };
    }
    // Codex hook session_id identifies the parent. Use only the explicit child
    // path or exact agent_id rollout lookup; the common transcript is parent-owned.
    codexParentId = payload.sessionId;
    payload = {
      ...payload,
      sessionId: payload.agentId,
      transcriptPath: payload.agentTranscriptPath,
    };
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

  // Async hooks (PostToolUse, Stop, SessionEnd) can overlap; the per-session
  // lock makes read-state → append → write-state atomic so no two events
  // share a `seq` and the spool order matches the sequence order.
  const lockPath = hookSessionLockPath(stateDirectory, payload.sessionId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (!(await acquireFileLock(lockPath, { waitMs: 5_000, staleMs: 30_000 }))) {
    log('ignored', `session=${sessionTag} lock busy`);
    return { action: 'ignored', detail: 'lock busy' };
  }
  try {
    if (isHookFenced(stateDirectory)) {
      log('fenced', `session=${sessionTag} event=${payload.hookEventName}`);
      return { action: 'ignored', detail: 'fenced' };
    }
    const state = readHookSessionState(stateDirectory, payload.sessionId);
    if (!shouldShipEvent(kind, state, now)) {
      writeHookSessionState(stateDirectory, {
        version: 1,
        sessionId: payload.sessionId,
        seq: state?.seq ?? 0,
        ...(state?.lastShippedAt && { lastShippedAt: state.lastShippedAt }),
        ...(state?.lastKind && { lastKind: state.lastKind }),
        updatedAt: now,
      });
      log('throttled', `session=${sessionTag}`);
      return { action: 'throttled' };
    }

    const transcriptPath = resolveTranscriptPath(deps, runtime, payload);
    const reduced = payload.isSubagent
      ? reduceCodexChildTranscript(
          deps,
          transcriptPath,
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
      // A reducer can supply provider identity, never host checkout facts.
      const deliverables = { ...withGit.deliverables };
      delete deliverables.publicationCheckouts;
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
      updatedAt: now,
    });
    log('spooled', `session=${sessionTag} kind=${kind} seq=${seq}`);
    if (inline) {
      await deps.runFlusher();
    } else {
      try {
        deps.spawnFlusher();
      } catch {
        log('flusher-spawn-failed');
      }
    }
    return { action: 'spooled', detail: `${kind} seq=${seq}` };
  } finally {
    releaseFileLock(lockPath);
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
      return subcommand === 'opencode'
        ? await handleOpencodeHook(deps, inline)
        : await handleRuntimeHook(deps, subcommand, inline);
    }
    if (subcommand === 'flush' || subcommand === '--flush') {
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
