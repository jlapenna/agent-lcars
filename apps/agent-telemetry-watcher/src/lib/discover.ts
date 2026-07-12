import * as fs from 'fs';
import * as path from 'path';

import { isAllowedProjectDir } from './allowlist';

/**
 * Lists every `*.jsonl` transcript file under allowlisted project dirs in
 * `claudeProjectsDir` (normally `~/.claude/projects`). Fails soft: a missing
 * root dir or an unreadable project dir yields fewer files, never a throw.
 */
export function discoverTranscriptFiles(
  claudeProjectsDir: string,
  allowlist: string[],
): string[] {
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory() || !isAllowedProjectDir(entry.name, allowlist)) {
      continue;
    }

    const projectDir = path.join(claudeProjectsDir, entry.name);
    let transcriptEntries: fs.Dirent[];
    try {
      transcriptEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const transcriptEntry of transcriptEntries) {
      if (transcriptEntry.isFile() && transcriptEntry.name.endsWith('.jsonl')) {
        files.push(path.join(projectDir, transcriptEntry.name));
      }
    }
  }

  return files;
}
