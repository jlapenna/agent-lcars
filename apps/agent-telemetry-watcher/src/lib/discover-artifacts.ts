import * as fs from 'fs';
import * as path from 'path';

/**
 * Lists filenames the share-media skill has written under
 * `<shareDir>/<sessionId>/` - its "conversation-id" convention is the Claude
 * Code session id itself for CLI sessions, so this session's own id is also
 * its share subdirectory. Fails soft: no share dir for this session (the
 * common case - most sessions never produce a shared artifact) yields an
 * empty list, never a throw.
 */
export function discoverSessionArtifacts(
  shareDir: string,
  sessionId: string,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(shareDir, sessionId), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}
