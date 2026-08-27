import { logger } from '@agent-lcars/logging';
import { claudeProjectSlugFor } from '@agent-lcars/telemetry';
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
 */
export async function resumeTranscript(
  options: ResumeTranscriptOptions,
): Promise<string | undefined> {
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
