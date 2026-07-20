import type { SessionDoc } from '@repo/agent-telemetry';
import { sessionAgent } from '@repo/agent-telemetry';
import {
  getAgentTelemetryReaderFirestore,
  getSessionDoc,
} from '@repo/agent-telemetry/server';

import {
  getSessionTranscript,
  type SessionTranscriptResult,
} from './session-transcript';

export type SessionDetailResult =
  | { status: 'ok'; doc: SessionDoc; transcript?: SessionTranscriptResult }
  | { status: 'not-found' }
  | { status: 'error'; warning: string };

/**
 * Loads everything the /sessions/[id] detail page needs: the doc itself,
 * plus - for an issue-agent doc that has one - its archived transcript.
 *
 * Two distinct failure modes are kept separate (see `SessionDetailResult`)
 * because the page treats them differently: a genuinely-missing doc is a
 * real 404 (`notFound()`), while a Firestore read failure is a degraded
 * page (a warning banner, still a 200 - matching every other fetcher in
 * this app). A transcript-fetch failure never reaches this level at all -
 * `getSessionTranscript` already absorbs it into its own `warning` field, so
 * the header still renders even when the transcript can't be shown.
 *
 * Only fetched for `sessionAgent(doc) === 'claude-code'` (#3123 phase 2):
 * `getSessionTranscript` parses `transcriptGcsUri` as a single Claude Code
 * `.jsonl` object, which is all that exists for every session shipped
 * before this phase. Non-Claude agents now archive-first (e.g. opencode.yml
 * uploading OpenCode's raw SQLite session storage under a `runs/<id>/opencode/`
 * GCS *prefix*, not one parseable file - see `types.ts`'s `transcriptGcsUri`
 * doc comment) - fetching that as a transcript would fail-soft into a scary
 * warning on every one of their session pages for no benefit, since there's
 * nothing renderable yet. The page instead shows a short note that the
 * archive exists without attempting to fetch/parse it.
 */
export async function getSessionDetail(
  sessionId: string,
): Promise<SessionDetailResult> {
  let doc: SessionDoc | undefined;
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    doc = await getSessionDoc(firestore, sessionId);
  } catch (error) {
    console.error('agent-console: failed to load session detail:', error);
    return {
      status: 'error',
      warning: 'Session detail unavailable (agent-telemetry store failed).',
    };
  }

  if (!doc) {
    return { status: 'not-found' };
  }

  const transcript =
    doc.source === 'issue-agent' &&
    doc.transcriptGcsUri &&
    sessionAgent(doc) === 'claude-code'
      ? await getSessionTranscript(doc.transcriptGcsUri)
      : undefined;

  return { status: 'ok', doc, ...(transcript && { transcript }) };
}
