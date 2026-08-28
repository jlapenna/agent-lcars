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

function defaultRunOpenCode(
  args: string[],
  options: CommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = Object.assign(new Error('OpenCode command timed out'), {
        code: 'ETIMEDOUT',
      });
      child.kill('SIGKILL');
    }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        failure = Object.assign(
          new Error(`OpenCode output exceeded ${options.maxBytes} bytes`),
          { code: 'OUTPUT_LIMIT' },
        );
        child.kill('SIGKILL');
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
  args: string[],
  outputPath: string,
  options: CommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(outputPath, 'wx', 0o600);
    const child = spawn('opencode', args, {
      stdio: ['ignore', output, 'ignore'],
    });
    fs.closeSync(output);
    let failure: Error | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(sizeCheck);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      failure = Object.assign(new Error('OpenCode command timed out'), {
        code: 'ETIMEDOUT',
      });
      child.kill('SIGKILL');
    }, options.timeout);
    const sizeCheck = setInterval(() => {
      try {
        if (fs.statSync(outputPath).size > options.maxBytes) {
          failure = Object.assign(
            new Error(`OpenCode output exceeded ${options.maxBytes} bytes`),
            { code: 'OUTPUT_LIMIT' },
          );
          child.kill('SIGKILL');
        }
      } catch {
        // The close/error path reports a missing output more usefully.
      }
    }, 25);

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
  const runOpenCode = options.runOpenCode ?? defaultRunOpenCode;
  const runOpenCodeToFile =
    options.runOpenCodeToFile ?? defaultRunOpenCodeToFile;
  let listOutput: string;
  try {
    listOutput = await runOpenCode(
      ['session', 'list', '--format', 'json', '-n', String(LIST_LIMIT)],
      { timeout: COMMAND_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES },
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
        ['export', session.id, '--sanitize'],
        captureFile,
        {
          timeout: COMMAND_TIMEOUT_MS,
          maxBytes: EXPORT_MAX_BYTES,
        },
      );
      const exportedJson = fs.readFileSync(captureFile, 'utf8');
      const parsed: unknown = JSON.parse(exportedJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('OpenCode export is not an object');
      }
      const exportRecord = parsed as Record<string, unknown>;
      const rawInfo =
        exportRecord['info'] && typeof exportRecord['info'] === 'object'
          ? (exportRecord['info'] as Record<string, unknown>)
          : {};
      if (rawInfo['id'] !== session.id) {
        throw new Error('OpenCode export session id did not match the request');
      }
      // `--sanitize` deliberately redacts session metadata and message/tool
      // bodies. The bounded list response was what selected this exact
      // workspace, so reattach only that known directory for summary
      // attribution. In particular, do not reattach the potentially
      // sensitive title from the list response.
      const normalizedInfo: Record<string, unknown> = {
        ...rawInfo,
        directory: session.directory,
      };
      delete normalizedInfo['title'];
      const normalized = {
        ...exportRecord,
        info: normalizedInfo,
      };
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
