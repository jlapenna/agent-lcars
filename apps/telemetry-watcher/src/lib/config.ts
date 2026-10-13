import { optional } from '@agent-lcars/env';
import * as os from 'os';
import * as path from 'path';

import { SESSION_STATE_DIRECTORY } from './session-title-paths';

/** Environment-driven settings `runner finalize` layers its own flags onto
 * (see `runner-config.ts`'s `loadRunnerConfig`). */
export interface SharedWatcherConfig {
  firestoreProjectId?: string;
  firestoreWriterKeyJson?: string;
  firestoreEmulatorHost?: string;
  /** `gs://` bucket (name only, no scheme) used by runner finalize. */
  transcriptsBucket?: string;
}

/** `~/.claude/projects` (or `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR` when set) —
 * the fallback for `runner finalize`'s `--projects-dir` and `runner
 * resume`'s destination root. */
export function defaultClaudeProjectsDir(): string {
  return (
    optional('AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR') ??
    path.join(os.homedir(), '.claude', 'projects')
  );
}

export function defaultCodexSessionsDir(): string {
  return (
    optional('AGENT_TELEMETRY_CODEX_SESSIONS_DIR') ??
    path.join(os.homedir(), '.codex', 'sessions')
  );
}

/** `~/.local/state/agent-lcars` — the session-title overlay root (issue
 * #1212), see `session-title-paths.ts`'s `SESSION_STATE_DIRECTORY`. */
export function defaultSessionStateDir(): string {
  return path.join(os.homedir(), SESSION_STATE_DIRECTORY);
}

/** Environment-driven settings shared by every runner-mode command. */
export function loadSharedConfig(): SharedWatcherConfig {
  const firestoreProjectId = optional('AGENT_TELEMETRY_PROJECT_ID');
  const transcriptsBucket =
    optional('AGENT_TELEMETRY_TRANSCRIPTS_BUCKET') ??
    (firestoreProjectId
      ? `${firestoreProjectId}-session-transcripts`
      : undefined);

  return {
    firestoreProjectId,
    firestoreWriterKeyJson: optional('AGENT_TELEMETRY_WRITER_KEY_JSON'),
    firestoreEmulatorHost: optional('FIRESTORE_EMULATOR_HOST'),
    ...(transcriptsBucket && { transcriptsBucket }),
  };
}
