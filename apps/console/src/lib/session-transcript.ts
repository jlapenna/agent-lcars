import type {
  TranscriptElisionDivider,
  TranscriptTimelineEvent,
} from '@agent-lcars/telemetry';
import {
  elideTranscriptTimeline,
  parseTranscriptTimeline,
} from '@agent-lcars/telemetry';
import { fetchSessionTranscript } from '@agent-lcars/telemetry/server';

export interface SessionTranscriptResult {
  events: (TranscriptTimelineEvent | TranscriptElisionDivider)[];
  /** Set when the fetch/parse degraded rather than crashed - GCS errors
   * (missing object, network/auth failure) and partially-unparseable
   * transcripts both surface here rather than as a thrown error, so the
   * session detail page can always render its header even when the
   * transcript can't be shown (never a 500 - see the detail page's own
   * try/catch-free design, since this function absorbs the failure). */
  warning?: string;
}

/**
 * Fetches and parses an issue-agent session's archived transcript for the
 * detail page's timeline section. Every failure mode - a malformed/expired
 * `gs://` URI, the object missing from the bucket, a network/auth error, or
 * a transcript with some unparseable lines - degrades to a warning rather
 * than throwing, matching every other read path in this app
 * (cli-sessions.ts/runner-sessions.ts/session-archive.ts).
 */
export async function getSessionTranscript(
  transcriptGcsUri: string,
): Promise<SessionTranscriptResult> {
  let raw: string;
  try {
    raw = await fetchSessionTranscript(transcriptGcsUri);
  } catch (error) {
    console.error(
      'agent-lcars: failed to fetch session transcript from storage:',
      error,
    );
    return {
      events: [],
      warning: 'Transcript unavailable (failed to fetch from storage).',
    };
  }

  const { events, hadUnparseableLines } = parseTranscriptTimeline(raw);
  return {
    events: elideTranscriptTimeline(events),
    ...(hadUnparseableLines && {
      warning: 'Some transcript lines could not be parsed and were skipped.',
    }),
  };
}
