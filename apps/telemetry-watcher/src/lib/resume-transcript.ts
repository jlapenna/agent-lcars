import { logger } from '@agent-lcars/logging';
import { claudeProjectSlugFor, isSafeIdentifier } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as path from 'path';

import { downloadTranscript } from './transcript-upload';

export interface ResumeTranscriptOptions {
  sessionId: string;
  transcriptGcsUri: string;
  cwd: string;
  claudeProjectsDir: string;
  projectId?: string;
  download?: (
    gcsUri: string,
    options?: { projectId?: string },
  ) => Promise<string>;
  mkdir?: (dir: string) => void;
  writeFile?: (filePath: string, contents: string) => void;
}

/**
 * Downloads a prior session's archived transcript into Claude Code's own
 * local session store for `cwd`, so a later `claude --resume <sessionId>`
 * (the lane's `claude_args`, or direct mode's literal CLI flag) finds it.
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

  const dir = path.join(
    options.claudeProjectsDir,
    claudeProjectSlugFor(options.cwd),
  );
  const file = path.join(dir, `${options.sessionId}.jsonl`);

  try {
    const contents = await download(options.transcriptGcsUri, {
      projectId: options.projectId,
    });
    mkdir(dir);
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
