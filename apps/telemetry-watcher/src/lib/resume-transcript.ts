import { logger } from '@agent-lcars/logging';
import { claudeProjectSlugFor, isSafeIdentifier } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  defaultRunOpenCode,
  OPENCODE_CAPTURE_LIMITS,
  resolveTrustedOpenCodeExecutable,
  RunOpenCode,
} from './opencode-export-capture';
import { downloadTranscript } from './transcript-upload';

/** OpenCode's `import` prints little more than "Imported session: <id>" --
 *  a small, fixed bound rather than reusing the much larger export caps. */
const IMPORT_MAX_BYTES = 64 * 1024;

export interface ResumeTranscriptOptions {
  /** Defaults to 'claude-code' so existing callers are unchanged. */
  agent?: 'claude-code' | 'codex' | 'opencode';
  sessionId: string;
  transcriptGcsUri: string;
  cwd: string;
  claudeProjectsDir: string;
  /** Required when `agent` is 'codex': the per-run CODEX_HOME. */
  codexHome?: string;
  projectId?: string;
  download?: (
    gcsUri: string,
    options?: { projectId?: string },
  ) => Promise<string>;
  mkdir?: (dir: string) => void;
  writeFile?: (filePath: string, contents: string) => void;
  /** 'opencode' only: pre-resolved executable test seam, mirroring
   *  `opencode-export-capture.ts`'s own contract -- production resolves
   *  only the trusted root-owned runner-image binary and never PATH. */
  opencodeExecutable?: string;
  /** 'opencode' only: runs the trusted OpenCode binary. Defaults to the
   *  same trusted-path-resolving spawn `captureOpenCodeExports` uses. */
  runOpenCode?: RunOpenCode;
  /** 'opencode' only: removes the temporary file used for `import`. */
  unlink?: (filePath: string) => void;
}

/**
 * Where the restored transcript has to land for each CLI to find it.
 *
 * Claude Code keys its store by a slug of the checkout directory, so the
 * path depends on `cwd`. Codex does not: it resolves a thread by the uuid
 * in the rollout's basename, and ignores both the date directory and the
 * timestamp in the name (measured against codex-cli 0.151.0 and
 * re-confirmed against the runner image's actual 0.153.2; see the plan's
 * "Verified Codex behavior" table). The epoch date below is therefore a
 * deliberate constant, not a derived value -- it makes a restored rollout
 * obvious on sight and avoids inventing a timestamp the archive no longer
 * carries, since the uploader renames the file to `<sessionId>.jsonl`.
 *
 * Returns `undefined` when `agent` is 'codex' but no `codexHome` was
 * given -- the caller is direct-runner.sh, which only knows CODEX_HOME
 * inside the codex branch, so a missing one here is a caller bug, not
 * something to crash on.
 */
function destinationFor(options: ResumeTranscriptOptions): string | undefined {
  if ((options.agent ?? 'claude-code') === 'codex') {
    if (options.codexHome === undefined) return undefined;
    return path.join(
      options.codexHome,
      'sessions/1970/01/01',
      `rollout-1970-01-01T00-00-00-${options.sessionId}.jsonl`,
    );
  }
  return path.join(
    options.claudeProjectsDir,
    claudeProjectSlugFor(options.cwd),
    `${options.sessionId}.jsonl`,
  );
}

/**
 * Downloads a prior session's archived transcript into Claude Code's own
 * local session store for `cwd`, so the QueueExecutor direct runner's later
 * `claude --resume <sessionId>` finds it.
 * Fails soft -- returns `undefined`, never throws -- on any download or
 * filesystem failure: a resume that cannot be prepared degrades to a
 * fresh run, matching every other telemetry failure mode in this
 * codebase (never block dispatch on a telemetry-adjacent step).
 *
 * `sessionId` arrives from untrusted document content (the work payload's
 * `resume.sessionId`, read via `jq -r` by the callers that build this
 * command line) and is joined directly into a filesystem path below, so it
 * must clear `isSafeIdentifier` before anything else runs -- the same
 * sessionId-to-filesystem-path guard `session-title-annotation-writer.ts`
 * and `session-title-annotation-source.ts` already apply at their own
 * sessionId boundaries. An id shaped like `../../../etc/passwd` would
 * otherwise resolve outside `claudeProjectsDir` via plain `path.join`.
 * Rejected up front, before the download call or any path is computed, so
 * a hostile id costs neither a GCS round trip nor a traversal attempt.
 */
export async function resumeTranscript(
  options: ResumeTranscriptOptions,
): Promise<string | undefined> {
  if (!isSafeIdentifier(options.sessionId)) {
    logger.warn(
      'agent-lcars-telemetry-watcher: resume-transcript rejected a session id that is not a safe identifier (path separators/traversal segments are not allowed), continuing without --resume',
    );
    return undefined;
  }

  const download = options.download ?? downloadTranscript;
  const mkdir =
    options.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const writeFile =
    options.writeFile ??
    ((filePath: string, contents: string) =>
      fs.writeFileSync(filePath, contents));

  if (options.agent === 'opencode') {
    return resumeOpenCodeSession(options, download, writeFile);
  }

  const file = destinationFor(options);
  if (file === undefined) return undefined;

  try {
    const contents = await download(options.transcriptGcsUri, {
      projectId: options.projectId,
    });
    mkdir(path.dirname(file));
    writeFile(file, contents);
    return file;
  } catch (error) {
    logger.warn(
      `agent-lcars-telemetry-watcher: resume-transcript failed for session ${options.sessionId}, continuing without --resume`,
      error,
    );
    return undefined;
  }
}

/**
 * Import, not a file write: OpenCode's store is a SQLite database, and
 * `import` is its own first-class way in. The binary is resolved through
 * the same trusted-path guard `captureOpenCodeExports` uses -- never PATH
 * -- and only lazily, inside the default `runOpenCode`, so a caller-
 * supplied test double (as every test here uses) never needs a real
 * trusted binary on disk. Returns the session id rather than a path: for
 * Claude and Codex `runner resume` prints the file it wrote, but OpenCode's
 * import has no such file -- the caller (`main.ts`) only needs a non-empty
 * success signal, and the session id is preserved across export/import
 * (measured), so the caller's `--session <id>` addresses the restored
 * conversation.
 */
async function resumeOpenCodeSession(
  options: ResumeTranscriptOptions,
  download: NonNullable<ResumeTranscriptOptions['download']>,
  writeFile: NonNullable<ResumeTranscriptOptions['writeFile']>,
): Promise<string | undefined> {
  let resolvedExecutable = options.opencodeExecutable;
  const runOpenCode: RunOpenCode =
    options.runOpenCode ??
    ((args, commandOptions) => {
      resolvedExecutable ??= resolveTrustedOpenCodeExecutable();
      if (!resolvedExecutable) {
        throw new Error(
          'No trusted OpenCode executable was available; refusing PATH execution',
        );
      }
      return defaultRunOpenCode(resolvedExecutable, args, commandOptions);
    });
  const unlink =
    options.unlink ?? ((filePath: string) => fs.unlinkSync(filePath));
  const temporary = path.join(
    os.tmpdir(),
    `opencode-resume-${options.sessionId}.json`,
  );

  try {
    const contents = await download(options.transcriptGcsUri, {
      projectId: options.projectId,
    });
    writeFile(temporary, contents);
    try {
      await runOpenCode(['--pure', 'import', temporary], {
        timeout: OPENCODE_CAPTURE_LIMITS.timeoutMs,
        maxBytes: IMPORT_MAX_BYTES,
      });
      return options.sessionId;
    } finally {
      try {
        unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(
            `agent-lcars-telemetry-watcher: failed to remove temporary OpenCode resume file ${temporary}`,
            cleanupError,
          );
        }
      }
    }
  } catch (error) {
    logger.warn(
      `agent-lcars-telemetry-watcher: resume-transcript failed to import OpenCode session ${options.sessionId}, continuing without --resume`,
      error,
    );
    return undefined;
  }
}
