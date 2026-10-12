import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applySessionTitleOverlay,
  claudeCodeAdapter,
  isSafeIdentifier,
  type SessionEventKind,
  type SessionEventV1,
  type SessionSummary,
} from '@agent-lcars/telemetry';

import { resolveGitBranch as defaultResolveGitBranch } from '../git-branch';
import { applyGitContext } from '../git-context';
import { resolveGitRepo as defaultResolveGitRepo } from '../git-repo';
import { readTranscriptLines as defaultReadTranscriptLines } from '../read-transcript-lines';
import {
  readSessionStatusOverlay,
  readSessionTitleOverlay,
} from '../session-title-annotation-source';
import { SESSION_STATE_DIRECTORY } from '../session-title-paths';
import {
  CLAUDE_HOOK_EVENT_KINDS,
  parseClaudeHookPayload,
} from './claude-hook-payload';
import { type HookClientConfig, loadHookClientConfig } from './hook-config';
import { appendHookLog } from './hook-log';
import {
  readHookSessionState,
  shouldShipEvent,
  writeHookSessionState,
} from './hook-state';
import { matchesRepoAllowlist } from './repo-allowlist';
import { shipSessionEvent } from './ship';
import { appendToSpool, drainSpool, spoolPath } from './spool';

/** Bumped when the event the client emits changes shape or semantics. */
export const HOOK_CLIENT_VERSION = '0.1.0';

export const HOOK_CLI_USAGE =
  'usage: lcars hook claude [--inline]   (reads one Claude Code hook payload on stdin)\n' +
  '       lcars hook flush               (posts spooled events to the console)\n' +
  '       Exits 0 and prints nothing on stdout in every case; decisions go to\n' +
  '       ~/.local/state/agent-lcars/hook.log.';

export type HookCommandAction =
  | 'usage'
  | 'ignored'
  | 'skipped-subagent'
  | 'skipped-unlisted'
  | 'throttled'
  | 'spooled'
  | 'flushed'
  | 'flush-locked'
  | 'flush-no-token';

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
  resolveGitRepo: (
    cwd: string,
  ) => Promise<{ owner: string; name: string } | undefined>;
  resolveGitBranch: (cwd: string) => Promise<string | undefined>;
  fetchImpl: typeof fetch;
  /** Starts `lcars hook flush` detached from the hook process. */
  spawnFlusher: () => void;
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
    resolveGitRepo: defaultResolveGitRepo,
    resolveGitBranch: defaultResolveGitBranch,
    fetchImpl: globalThis.fetch,
    spawnFlusher: () => {
      // process.argv[1] is the bundle (or the dev entry) that is running
      // this very command, so the flusher is always the same client version.
      const child = spawn(
        process.execPath,
        [process.argv[1], 'hook', 'flush'],
        {
          detached: true,
          stdio: 'ignore',
          env,
        },
      );
      child.unref();
    },
    randomId: () => crypto.randomUUID(),
    hostname: () => os.hostname(),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

function stateDirectoryFor(deps: HookCommandDependencies): string {
  return path.join(deps.homeDirectory, SESSION_STATE_DIRECTORY);
}

function zeroSummary(
  sessionId: string,
  now: string,
  cwd: string | undefined,
): SessionSummary {
  return {
    sessionId,
    source: 'cli',
    agent: 'claude-code',
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
    ...(cwd && { cwd }),
  };
}

function reduceClaudeTranscript(
  deps: HookCommandDependencies,
  transcriptPath: string | undefined,
  sessionId: string,
): SessionSummary | undefined {
  if (!transcriptPath || !deps.fileExists(transcriptPath)) return undefined;
  try {
    const summaries = claudeCodeAdapter.reduce(
      deps.readTranscriptLines(transcriptPath),
    );
    return (
      summaries.find((summary) => summary.sessionId === sessionId) ??
      summaries[0]
    );
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

async function flush(
  deps: HookCommandDependencies,
  config: HookClientConfig,
): Promise<HookCommandResult> {
  const stateDirectory = stateDirectoryFor(deps);
  if (!config.token) {
    appendHookLog(stateDirectory, `${deps.now().toISOString()} flush no-token`);
    return { action: 'flush-no-token' };
  }
  const token = config.token;
  const result = await drainSpool(spoolPath(stateDirectory), async (event) => {
    const shipped = await shipSessionEvent(event as SessionEventV1, {
      origin: config.origin,
      token,
      fetchImpl: deps.fetchImpl,
    });
    if (shipped.outcome !== 'sent') {
      appendHookLog(
        stateDirectory,
        `${deps.now().toISOString()} flush ${shipped.outcome} status=${shipped.status ?? 'network'}`,
      );
    }
    return shipped.outcome;
  });
  const detail = `sent=${result.sent} dropped=${result.dropped} remaining=${result.remaining}`;
  appendHookLog(
    stateDirectory,
    `${deps.now().toISOString()} flush ${result.locked ? 'locked' : 'done'} ${detail}`,
  );
  return { action: result.locked ? 'flush-locked' : 'flushed', detail };
}

async function handleClaude(
  deps: HookCommandDependencies,
  inline: boolean,
): Promise<HookCommandResult> {
  const stateDirectory = stateDirectoryFor(deps);
  const now = deps.now().toISOString();
  const log = (action: string, detail = '') =>
    appendHookLog(
      stateDirectory,
      `${now} claude ${action} ${detail}`.trimEnd(),
    );

  const payload = parseClaudeHookPayload(deps.readStdin());
  if (!payload) {
    log('ignored', 'unparseable payload');
    return { action: 'ignored', detail: 'unparseable payload' };
  }
  const kind: SessionEventKind | undefined =
    CLAUDE_HOOK_EVENT_KINDS[payload.hookEventName];
  if (!kind) {
    log('ignored', `event=${payload.hookEventName}`);
    return { action: 'ignored', detail: payload.hookEventName };
  }
  if (payload.isSubagent) {
    log('skipped-subagent', `event=${payload.hookEventName}`);
    return { action: 'skipped-subagent' };
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
    repo = payload.cwd ? await deps.resolveGitRepo(payload.cwd) : undefined;
    if (!repo || !matchesRepoAllowlist(repo, config.repos)) {
      log(
        'skipped-unlisted',
        `session=${sessionTag} event=${payload.hookEventName}`,
      );
      return { action: 'skipped-unlisted' };
    }
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

  const reduced = reduceClaudeTranscript(
    deps,
    payload.transcriptPath,
    payload.sessionId,
  );
  let summary: SessionSummary | undefined;
  if (reduced || kind !== 'end') {
    const base = reduced ?? zeroSummary(payload.sessionId, now, payload.cwd);
    const withHost: SessionSummary = {
      ...base,
      sessionId: payload.sessionId,
      host: config.host,
      ...(base.cwd === undefined && payload.cwd && { cwd: payload.cwd }),
      repo,
    };
    const withGit = await applyGitContext(
      withHost,
      deps.resolveGitBranch,
      async () => repo,
    );
    summary = applyAnnotationOverlays(stateDirectory, withGit);
  }

  const seq = (state?.seq ?? 0) + 1;
  const event: SessionEventV1 = {
    version: 1,
    eventId: deps.randomId(),
    seq,
    occurredAt: now,
    host: config.host,
    agent: 'claude-code',
    sessionId: payload.sessionId,
    kind,
    runtime: {
      name: 'claude-code',
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
    await flush(deps, config);
  } else {
    try {
      deps.spawnFlusher();
    } catch {
      log('flusher-spawn-failed');
    }
  }
  return { action: 'spooled', detail: `${kind} seq=${seq}` };
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
    if (subcommand === 'claude') {
      return await handleClaude(deps, rest.includes('--inline'));
    }
    if (subcommand === 'flush' || subcommand === '--flush') {
      const config = loadHookClientConfig({
        homeDirectory: deps.homeDirectory,
        env: deps.env,
        hostname: deps.hostname,
      });
      return await flush(deps, config);
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
