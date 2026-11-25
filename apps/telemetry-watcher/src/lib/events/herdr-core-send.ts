import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isHerdrPaneId } from '@agent-lcars/telemetry';

/**
 * What `hc send` did.
 *
 * - `sent`: the text went in. `started` is herdr-core's own answer to
 *   whether the program went to work within a few seconds; `null` when it
 *   could not tell.
 * - `refused`: the terminal was busy or on a dialog (`blocked`,
 *   `status_mismatch`), so nothing was typed; try again later.
 * - `gone`: the terminal finished or no longer exists.
 * - `failed`: anything else, including `hc` itself failing to run.
 */
export type HerdrSendResult =
  | { readonly kind: 'sent'; readonly started: boolean | null }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'gone'; readonly error: string }
  | { readonly kind: 'failed'; readonly error: string };

export type RunFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}>;

const SEND_TIMEOUT_MS = 45_000;

export const defaultRunFile: RunFile = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : null;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pastes `text` into a local herdr-core terminal and presses Enter, with
 * `hc send`. herdr-core waits until nobody has typed for a moment and
 * refuses a program that is blocked on a dialog, so an approval prompt is
 * never answered by a notice.
 */
export async function herdrCoreSend(
  run: RunFile,
  hc: string,
  address: string,
  text: string,
): Promise<HerdrSendResult> {
  // A local address only: never an option, never another machine.
  if (!isHerdrPaneId(address)) return { kind: 'gone', error: 'bad_address' };
  const result = await run(hc, ['send', '--json', '--', address, text], {
    timeoutMs: SEND_TIMEOUT_MS,
  });
  const answer = parseJson(result.stdout) ?? parseJson(result.stderr);
  const error = answer?.['error'];
  if (result.code === 0 && answer && error === undefined) {
    const started = answer['started'];
    return {
      kind: 'sent',
      started: typeof started === 'boolean' ? started : null,
    };
  }
  const kind =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['kind']
      : undefined;
  const reason = typeof kind === 'string' ? kind : `exit_${result.code}`;
  if (reason === 'blocked' || reason === 'status_mismatch') {
    return { kind: 'refused', error: reason };
  }
  if (reason === 'not_found' || reason === 'finished') {
    return { kind: 'gone', error: reason };
  }
  return { kind: 'failed', error: reason };
}

/** `HC`, else the per-user install, else `hc` on `PATH`: a user service's
 * `PATH` rarely includes `~/.local/bin`. */
export function resolveHcBinary(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
): string {
  const configured = env['HC']?.trim();
  if (configured) return configured;
  const local = path.join(home, '.local', 'bin', 'hc');
  return exists(local) ? local : 'hc';
}
