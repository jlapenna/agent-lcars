import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { SessionDoc } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  getSessionDoc,
} from '@agent-lcars/telemetry/server';

import {
  getSessionTranscript,
  resolveSessionTranscriptTarget,
  type SessionTranscriptResult,
} from './session-transcript';

export type SessionDetailResult =
  | { status: 'ok'; doc: SessionDoc; transcript?: SessionTranscriptResult }
  | { status: 'not-found' }
  | { status: 'error'; warning: string };

/**
 * Loads everything the /sessions/[id] detail page needs: the doc itself,
 * plus the first page of its renderable archived transcript (CLI archives
 * require unexpired consent; subsequent pages load incrementally via
 * `/api/sessions/[id]/transcript`).
 *
 * Two distinct failure modes are kept separate (see `SessionDetailResult`)
 * because the page treats them differently: a genuinely-missing doc is a
 * real 404 (`notFound()`), while a Firestore read failure is a degraded
 * page (a warning banner, still a 200 - matching every other fetcher in
 * this app). A transcript-fetch failure never reaches this level at all -
 * `getSessionTranscript` already absorbs it into its own `warning` field, so
 * the header still renders even when the transcript can't be shown.
 *
 * The persisted renderable flag gates the normal transcript archive. OpenCode
 * also has a separate full export for resume; that envelope is renderable even
 * on older docs captured before the timeline parser existed. Reading it never
 * changes the archive or the provider identity.
 */
export async function getSessionDetail(
  sessionId: string,
): Promise<SessionDetailResult> {
  let doc: SessionDoc | undefined;
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    doc = await getSessionDoc(firestore, sessionId);
  } catch (error) {
    logger.error('agent-lcars: failed to load session detail:', error);
    return {
      status: 'error',
      warning: 'Session detail unavailable (agent-telemetry store failed).',
    };
  }

  if (!doc) {
    return { status: 'not-found' };
  }

  const target = resolveSessionTranscriptTarget(doc);
  const transcript: SessionTranscriptResult | undefined =
    target.status === 'eligible'
      ? await getSessionTranscript(target.transcriptGcsUri, target.agent)
      : target.status === 'expired'
        ? { events: [], warning: target.warning }
        : undefined;

  return { status: 'ok', doc, ...(transcript && { transcript }) };
}
