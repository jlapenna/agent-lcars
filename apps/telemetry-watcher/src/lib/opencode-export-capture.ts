import { logger } from '@agent-lcars/logging';
import { isSafeIdentifier } from '@agent-lcars/telemetry';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LIST_LIMIT = 100;
const SESSION_LIMIT = 20;
const LIST_MAX_BYTES = 1024 * 1024;
const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;

interface CommandOptions {
  timeout: number;
  maxBytes: number;
}

interface CaptureLimitsOverride {
  /** Test seam; production always uses OPENCODE_CAPTURE_LIMITS.timeoutMs. */
  timeoutMs?: number;
  /** Test seam; production always uses OPENCODE_CAPTURE_LIMITS.exportBytes. */
  exportBytes?: number;
}

export type RunOpenCode = (
  args: string[],
  options: CommandOptions,
) => string | Promise<string>;

export type RunOpenCodeToFile = (
  args: string[],
  outputPath: string,
  options: CommandOptions,
) => void | Promise<void>;

export interface CaptureOpenCodeExportsOptions {
  workspaceDir: string;
  exportsDir: string;
  runOpenCode?: RunOpenCode;
  runOpenCodeToFile?: RunOpenCodeToFile;
  /** Pre-resolved executable test seam. Production resolves only trusted
   * installation locations and fails closed when none passes validation. */
  opencodeExecutable?: string;
  limits?: CaptureLimitsOverride;
}

export interface CaptureOpenCodeExportsResult {
  status: 'ok' | 'cli-unavailable' | 'list-failed';
  selected: number;
  exported: number;
  failed: number;
}

interface ListedSession {
  id: string;
  directory: string;
  updated: number;
}

const CHILD_ENV_ALLOWLIST = [
  'HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

function commandUnavailable(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ENOENT' });
}

function trustedNode(
  candidate: string,
  expectedUid: number,
  type: 'file' | 'directory',
): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return (
      !stat.isSymbolicLink() &&
      (type === 'file' ? stat.isFile() : stat.isDirectory()) &&
      stat.uid === expectedUid &&
      (stat.mode & 0o022) === 0 &&
      (type === 'directory' || (stat.mode & 0o111) !== 0)
    );
  } catch {
    return false;
  }
}

/** Checks the executable plus its two install directories as one boundary. */
export function isTrustedOpenCodePath(
  candidate: string,
  expectedUid = 0,
): boolean {
  const binDir = path.dirname(candidate);
  const installDir = path.dirname(binDir);
  return (
    trustedNode(installDir, expectedUid, 'directory') &&
    trustedNode(binDir, expectedUid, 'directory') &&
    trustedNode(candidate, expectedUid, 'file')
  );
}

/**
 * Privileged telemetry capture resolves only the root-owned runner-image
 * location. The action-installed `$HOME/.opencode/bin/opencode` is writable by
 * the same uid as the agent and is therefore intentionally never eligible,
 * even with `--pure` and a scrubbed child environment. PATH is never consulted.
 * Until the runner image owns this executable, capture fails closed and the
 * separate non-privileged trajectory artifact remains the available archive.
 */
export function resolveTrustedOpenCodeExecutable(
  candidate = '/usr/local/bin/opencode',
): string | undefined {
  return isTrustedOpenCodePath(candidate) ? candidate : undefined;
}

function openCodeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function killCommand(child: {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}) {
  if (child.pid !== undefined) {
    try {
      // Commands run in their own process group so plugin/subprocess bugs
      // cannot retain stdout or outlive the timeout after the parent dies.
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to the direct child if it exited between the timer and kill.
    }
  }
  child.kill('SIGKILL');
}

function defaultRunOpenCode(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      env: openCodeChildEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = Object.assign(new Error('OpenCode command timed out'), {
        code: 'ETIMEDOUT',
      });
      killCommand(child);
    }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        failure = Object.assign(
          new Error(`OpenCode output exceeded ${options.maxBytes} bytes`),
          { code: 'OUTPUT_LIMIT' },
        );
        killCommand(child);
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(
          new Error(
            `OpenCode exited ${code ?? 'without a code'}${signal ? ` (${signal})` : ''}`,
          ),
        );
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

function defaultRunOpenCodeToFile(
  executable: string,
  args: string[],
  outputPath: string,
  options: CommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fileBlocks = Math.floor(options.maxBytes / 1024);
    if (fileBlocks < 1) {
      reject(new Error('OpenCode file bound must be at least 1024 bytes'));
      return;
    }
    const output = fs.openSync(outputPath, 'wx', 0o600);
    // OpenCode/Bun truncates large exports when stdout is a pipe, so capture
    // must remain file-backed. RLIMIT_FSIZE is the hard kernel-enforced bound:
    // unlike stat polling, a fast writer cannot overshoot it. The executable
    // and all arguments are passed after the shell program and expanded only
    // through "$@"; no session-controlled value is interpolated as shell code.
    const child = spawn(
      '/bin/bash',
      [
        '-c',
        'ulimit -f "$1"; shift; exec "$@"',
        'opencode-bounded-export',
        String(fileBlocks),
        executable,
        ...args,
      ],
      {
        detached: true,
        env: openCodeChildEnv(),
        stdio: ['ignore', output, 'ignore'],
      },
    );
    fs.closeSync(output);
    let failure: Error | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      failure = Object.assign(new Error('OpenCode command timed out'), {
        code: 'ETIMEDOUT',
      });
      killCommand(child);
    }, options.timeout);
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (failure) return finish(failure);
      let size: number;
      try {
        size = fs.statSync(outputPath).size;
      } catch (error) {
        return finish(error as Error);
      }
      if (size > options.maxBytes) {
        return finish(
          Object.assign(
            new Error(`OpenCode output exceeded ${options.maxBytes} bytes`),
            { code: 'OUTPUT_LIMIT' },
          ),
        );
      }
      if (code !== 0) {
        return finish(
          new Error(
            `OpenCode exited ${code ?? 'without a code'}${signal ? ` (${signal})` : ''}`,
          ),
        );
      }
      return finish();
    });
  });
}

function sessionTimestamp(session: Record<string, unknown>): number {
  const time =
    session['time'] && typeof session['time'] === 'object'
      ? (session['time'] as Record<string, unknown>)
      : undefined;
  const candidate =
    session['updated'] ??
    time?.['updated'] ??
    session['time_updated'] ??
    session['created'] ??
    time?.['created'] ??
    session['time_created'];
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : 0;
}

function parseSessionList(
  contents: string,
  workspaceDir: string,
): ListedSession[] {
  if (!contents.trim()) return [];
  const parsed: unknown = JSON.parse(contents);
  if (!Array.isArray(parsed)) throw new Error('session list is not an array');
  const workspace = path.resolve(workspaceDir);
  return parsed
    .flatMap((value): ListedSession[] => {
      if (!value || typeof value !== 'object') return [];
      const session = value as Record<string, unknown>;
      const id = session['id'];
      const directory = session['directory'];
      if (
        typeof id !== 'string' ||
        !isSafeIdentifier(id) ||
        typeof directory !== 'string' ||
        path.resolve(directory) !== workspace
      ) {
        return [];
      }
      return [
        {
          id,
          directory,
          updated: sessionTimestamp(session),
        },
      ];
    })
    .sort((a, b) => b.updated - a.updated)
    .slice(0, SESSION_LIMIT);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function boundedString(value: unknown, maxLength = 256): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

function allowlistedTime(
  value: unknown,
  fields: readonly string[],
): Record<string, number> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result: Record<string, number> = {};
  for (const field of fields) {
    const number = finiteNumber(source[field]);
    if (number !== undefined) result[field] = number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function allowlistedTokens(
  value: unknown,
): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  for (const field of ['input', 'output', 'reasoning'] as const) {
    const number = finiteNumber(source[field]);
    if (number !== undefined) result[field] = Math.max(0, number);
  }
  const cacheSource = asRecord(source['cache']);
  const cache: Record<string, number> = {};
  for (const field of ['read', 'write'] as const) {
    const number = finiteNumber(cacheSource?.[field]);
    if (number !== undefined) cache[field] = Math.max(0, number);
  }
  if (Object.keys(cache).length > 0) result['cache'] = cache;
  return Object.keys(result).length > 0 ? result : undefined;
}

function allowlistedToolPart(
  value: unknown,
): Record<string, unknown> | undefined {
  const part = asRecord(value);
  if (!part || part['type'] !== 'tool') return undefined;
  const tool = boundedString(part['tool'], 128);
  if (!tool) return undefined;
  const state = asRecord(part['state']);
  const time = allowlistedTime(state?.['time'], ['start', 'end']);
  return {
    type: 'tool',
    tool,
    ...(time && { state: { time } }),
  };
}

function allowlistedMessage(
  value: unknown,
): Record<string, unknown> | undefined {
  const message = asRecord(value);
  const sourceInfo = asRecord(message?.['info']);
  if (!message || !sourceInfo) return undefined;

  const role =
    sourceInfo['role'] === 'user' || sourceInfo['role'] === 'assistant'
      ? sourceInfo['role']
      : undefined;
  const time = allowlistedTime(sourceInfo['time'], ['created', 'completed']);
  const providerID = boundedString(sourceInfo['providerID']);
  const modelID = boundedString(sourceInfo['modelID']);
  const tokens = allowlistedTokens(sourceInfo['tokens']);
  const cost = finiteNumber(sourceInfo['cost']);
  const info: Record<string, unknown> = {
    ...(role && { role }),
    ...(time && { time }),
    ...(providerID && { providerID }),
    ...(modelID && { modelID }),
    ...(tokens && { tokens }),
    ...(cost !== undefined && { cost }),
  };
  const parts = Array.isArray(message['parts'])
    ? message['parts'].flatMap((part) => {
        const allowlisted = allowlistedToolPart(part);
        return allowlisted ? [allowlisted] : [];
      })
    : [];
  return { info, parts };
}

/**
 * Converts a sanitized CLI export into the strict metadata-only archive
 * contract consumed by the adapter. This is an allowlist, not a redaction
 * denylist: arbitrary top-level fields and nested metadata/share/permission,
 * paths, message text, tool input, and tool output cannot enter the JSONL even
 * if a future OpenCode sanitizer leaves them present.
 */
function materializeSafeExport(
  exportRecord: Record<string, unknown>,
  session: ListedSession,
): Record<string, unknown> {
  const rawInfo = asRecord(exportRecord['info']);
  if (rawInfo?.['id'] !== session.id) {
    throw new Error('OpenCode export session id did not match the request');
  }
  const time = allowlistedTime(rawInfo['time'], ['created', 'updated']);
  const messages = Array.isArray(exportRecord['messages'])
    ? exportRecord['messages'].flatMap((message) => {
        const allowlisted = allowlistedMessage(message);
        return allowlisted ? [allowlisted] : [];
      })
    : [];
  return {
    info: {
      id: session.id,
      directory: session.directory,
      ...(time && { time }),
    },
    messages,
  };
}

function isCommandUnavailable(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Materializes OpenCode's SQLite-backed sessions into bounded one-record
 * JSONL files. OpenCode owns the database schema; this capture uses its public
 * `session list --format json` and sanitized `export <id>` commands instead
 * of querying tables directly. The runner watcher can then reuse its existing
 * file/change-detection/archive pipeline without coupling to that schema.
 */
export async function captureOpenCodeExports(
  options: CaptureOpenCodeExportsOptions,
): Promise<CaptureOpenCodeExportsResult> {
  let resolvedExecutable = options.opencodeExecutable;
  const executable = (): string => {
    resolvedExecutable ??= resolveTrustedOpenCodeExecutable();
    if (!resolvedExecutable) {
      throw commandUnavailable(
        'No trusted OpenCode executable was available; refusing PATH execution',
      );
    }
    return resolvedExecutable;
  };
  const runOpenCode =
    options.runOpenCode ??
    ((args, commandOptions) =>
      defaultRunOpenCode(executable(), args, commandOptions));
  const runOpenCodeToFile =
    options.runOpenCodeToFile ??
    ((args, outputPath, commandOptions) =>
      defaultRunOpenCodeToFile(executable(), args, outputPath, commandOptions));
  const commandTimeoutMs = options.limits?.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const exportMaxBytes = options.limits?.exportBytes ?? EXPORT_MAX_BYTES;
  let listOutput: string;
  try {
    listOutput = await runOpenCode(
      [
        '--pure',
        'session',
        'list',
        '--format',
        'json',
        '-n',
        String(LIST_LIMIT),
      ],
      { timeout: commandTimeoutMs, maxBytes: LIST_MAX_BYTES },
    );
  } catch (error) {
    if (isCommandUnavailable(error)) {
      return { status: 'cli-unavailable', selected: 0, exported: 0, failed: 0 };
    }
    logger.warn(
      'agent-lcars-telemetry-watcher: OpenCode session listing failed; skipping this capture pass',
      error,
    );
    return { status: 'list-failed', selected: 0, exported: 0, failed: 0 };
  }

  let sessions: ListedSession[];
  try {
    sessions = parseSessionList(listOutput, options.workspaceDir);
  } catch (error) {
    logger.warn(
      'agent-lcars-telemetry-watcher: OpenCode session list was malformed; skipping this capture pass',
      error,
    );
    return { status: 'list-failed', selected: 0, exported: 0, failed: 0 };
  }

  const sessionsDir = path.join(options.exportsDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const selectedFiles = new Set(sessions.map(({ id }) => `${id}.jsonl`));
  let exported = 0;
  let failed = 0;

  for (const session of sessions) {
    const destination = path.join(sessionsDir, `${session.id}.jsonl`);
    const captureFile = `${destination}.capture-${process.pid}-${Date.now()}`;
    const normalizedFile = `${destination}.tmp-${process.pid}-${Date.now()}`;
    try {
      await runOpenCodeToFile(
        ['--pure', 'export', session.id, '--sanitize'],
        captureFile,
        {
          timeout: commandTimeoutMs,
          maxBytes: exportMaxBytes,
        },
      );
      const exportedJson = fs.readFileSync(captureFile, 'utf8');
      const parsed: unknown = JSON.parse(exportedJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('OpenCode export is not an object');
      }
      const exportRecord = parsed as Record<string, unknown>;
      const normalized = materializeSafeExport(exportRecord, session);
      const compact = `${JSON.stringify(normalized)}\n`;
      fs.writeFileSync(normalizedFile, compact, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(normalizedFile, destination);
      exported++;
    } catch (error) {
      failed++;
      logger.warn(
        `agent-lcars-telemetry-watcher: failed to export OpenCode session ${session.id}; skipping it`,
        error,
      );
    } finally {
      for (const temporary of [captureFile, normalizedFile]) {
        try {
          fs.unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(
              `agent-lcars-telemetry-watcher: failed to remove temporary OpenCode capture ${temporary}`,
              error,
            );
          }
        }
      }
    }
  }

  // The capture directory is task-owned scratch space. Keeping only this
  // pass's bounded selection prevents a long-lived process from accumulating
  // more files than SESSION_LIMIT as sessions age out of the CLI list.
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.endsWith('.jsonl') &&
        !selectedFiles.has(entry.name)
      ) {
        fs.unlinkSync(path.join(sessionsDir, entry.name));
      }
    }
  } catch (error) {
    logger.warn(
      'agent-lcars-telemetry-watcher: failed to prune stale OpenCode capture files',
      error,
    );
  }

  return { status: 'ok', selected: sessions.length, exported, failed };
}

export const OPENCODE_CAPTURE_LIMITS = {
  list: LIST_LIMIT,
  sessions: SESSION_LIMIT,
  listBytes: LIST_MAX_BYTES,
  exportBytes: EXPORT_MAX_BYTES,
  timeoutMs: COMMAND_TIMEOUT_MS,
} as const;
