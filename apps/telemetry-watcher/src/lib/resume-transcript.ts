import { logger } from '@agent-lcars/logging';
import { claudeProjectSlugFor, isSafeIdentifier } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as path from 'path';

import { downloadTranscript } from './transcript-upload';

export interface ResumeTranscriptOptions {
  /** Defaults to 'claude-code' so existing callers are unchanged. */
  agent?: 'claude-code' | 'codex';
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
