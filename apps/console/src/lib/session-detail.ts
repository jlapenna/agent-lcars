import 'server-only';

import type { SessionDoc } from '@agent-lcars/telemetry';
import { isSessionRenderable, sessionAgent } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  getSessionDoc,
} from '@agent-lcars/telemetry/server';

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
 * Only fetched when `isSessionRenderable(doc)` is true (#3123 phase 2,
 * updated to read the `renderable` field in #645): `getSessionTranscript`
 * parses `transcriptGcsUri` as a single `.jsonl` object via the agent-specific
 * branch in `parseTranscriptTimeline` (see `RENDERABLE_TRANSCRIPT_AGENTS` in
 * `transcript-timeline.ts`). Unsupported agents may archive-first rather
 * than ship a parseable transcript at
 * all (e.g. OpenCode's raw local session storage, which is a single SQLite
 * database rather than a per-session file - see `types.ts`'s
 * `transcriptGcsUri` doc comment) - fetching either shape as a transcript
 * would fail-soft into a scary warning on every one of their session pages
 * for no benefit, since there's nothing renderable yet. The page instead
 * shows a short note that the archive exists without attempting to
 * fetch/parse it. This gate is deliberately read from `doc.renderable`
 * (Worker runtime's own claim, set once at capture time) rather than
 * re-derived here from `sessionAgent(doc)` - see `isSessionRenderable`'s own
 * doc comment for why re-deriving it was Bug 3.
 */
export async function getSessionDetail(
  sessionId: string,
): Promise<SessionDetailResult> {
  let doc: SessionDoc | undefined;
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    doc = await getSessionDoc(firestore, sessionId);
  } catch (error) {
    console.error('agent-lcars: failed to load session detail:', error);
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
    isSessionRenderable(doc)
      ? await getSessionTranscript(doc.transcriptGcsUri, sessionAgent(doc))
      : undefined;

  return { status: 'ok', doc, ...(transcript && { transcript }) };
}
