import * as fs from 'fs';
import * as path from 'path';

import { isAllowedProjectDir } from './allowlist';
import { WatchRootConfig } from './watch-roots';

/**
 * Lists every `*.jsonl` transcript file under allowlisted project dirs in
 * `claudeProjectsDir` (normally `~/.claude/projects`). Fails soft: a missing
 * root dir or an unreadable project dir yields fewer files, never a throw.
 */
export function discoverTranscriptFiles(
  claudeProjectsDir: string,
  allowlist: string[],
  recursive = false,
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
    if (recursive) {
      files.push(...discoverJsonlRecursively(projectDir));
      continue;
    }
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

function discoverJsonlRecursively(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverJsonlRecursively(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

export interface DiscoveredFile {
  file: string;
  /** The watch root this file was discovered under — carries the adapter to
   * reduce it with and (for logging/debugging) which allowlist scoped it
   * in. */
  root: WatchRootConfig;
}

/**
 * Discovers transcript files across every configured watch root
 * independently, tagging each with the root it came from. A root with no
 * `projectDirAllowlist` watches every project dir under it unfiltered
 * (`['*']`) rather than none — see {@link WatchRootConfig.projectDirAllowlist}'s
 * doc comment for why an *absent* allowlist means "no restriction" while an
 * *empty* one (`[]`) would mean "nothing matches" per `isAllowedProjectDir`.
 * Roots are independent: the same project-dir basename can be in scope
 * under one root and out of scope under another, and a file path colliding
 * across two roots is not deduplicated (roots are expected to point at
 * disjoint directory trees).
 */
export function discoverAcrossRoots(
  watchRoots: WatchRootConfig[],
  discover: (
    rootPath: string,
    allowlist: string[],
    recursive?: boolean,
  ) => string[] = discoverTranscriptFiles,
): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  for (const root of watchRoots) {
    for (const file of discover(
      root.path,
      root.projectDirAllowlist ?? ['*'],
      root.recursive,
    )) {
      files.push({ file, root });
    }
  }
  return files;
}
