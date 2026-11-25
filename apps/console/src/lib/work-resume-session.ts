import {
  isClaudeSubagentSessionId,
  type SessionDoc,
} from '@agent-lcars/telemetry';

/** The pipelines whose CLI session can be restored. Values are
 *  `SessionAgent` members (`libs/telemetry/src/lib/types.ts`), matching
 *  what `selectResumeSession` compares against `doc.agent` below. */
const RESUMABLE_PIPELINES: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  agy: 'antigravity',
};

/** The artifact a resume actually restores from. Claude and Codex archive
 *  their raw session, so it is the transcript itself; OpenCode's transcript
 *  is a sanitized rendering whose every word is a redaction marker, so only
 *  its separate raw export can carry the conversation -- an OpenCode
 *  session therefore never falls back to `transcriptGcsUri`, even when it
 *  has one (e.g. the raw-export capture failed but the sanitized capture
 *  didn't; see `opencode-export-capture.ts`). Falling back there would
 *  silently resume into redaction markers, exactly what `resumeGcsUri` was
 *  added to prevent. */
export function resumeUriFor(doc: SessionDoc): string | undefined {
  if (doc.source !== 'issue-agent' || doc.transcriptGcsUri === undefined) {
    return undefined;
  }
  if (doc.agent === 'claude-code' && isClaudeSubagentSessionId(doc.sessionId)) {
    return undefined;
  }
  if (doc.agent === 'opencode') {
    return doc.resumeGcsUri;
  }
  return doc.resumeGcsUri ?? doc.transcriptGcsUri;
}

/**
 * The newest session that this item can actually resume: it must belong to
 * one of this item's own runs, carry a resumable artifact, and be the
 * agent the requested pipeline runs. Pure, so the ownership rules are
 * testable without a Firestore double.
 */
export function selectResumeSession(
  sessions: readonly SessionDoc[],
  runIds: ReadonlySet<string>,
  pipeline: string,
): SessionDoc | undefined {
  const agent = RESUMABLE_PIPELINES[pipeline];
  if (agent === undefined) return undefined;
  return sessions
    .filter(
      (doc) =>
        doc.source === 'issue-agent' &&
        doc.intentId !== undefined &&
        runIds.has(doc.intentId) &&
        doc.agent === agent &&
        resumeUriFor(doc) !== undefined,
    )
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
}

/** The resume request for the newest session of `runs` the pipeline can
 * restore, or no params when none can be: the run then starts fresh and
 * reads its input from the brief. Shared by human replies and event
 * resumes. */
export function resumeParamsFor(
  sessions: readonly SessionDoc[],
  runIds: ReadonlySet<string>,
  pipeline: string,
): Record<string, string> {
  const chosen = selectResumeSession(sessions, runIds, pipeline);
  const resumeUri = chosen === undefined ? undefined : resumeUriFor(chosen);
  return chosen === undefined || resumeUri === undefined
    ? {}
    : {
        resumeSessionId: chosen.sessionId,
        resumeTranscriptGcsUri: resumeUri,
      };
}
