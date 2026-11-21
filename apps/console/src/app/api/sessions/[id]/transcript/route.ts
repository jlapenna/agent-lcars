import { logger } from '@agent-lcars/logging';
import type { SessionDoc } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  getSessionDoc,
} from '@agent-lcars/telemetry/server';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import {
  getSessionTranscript,
  parseTranscriptCursor,
  resolveSessionTranscriptTarget,
  type TranscriptPageApiResponse,
} from '@/lib/session-transcript';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Paginated transcript reader for `/sessions/[id]`. Enforces the exact same
 * admin authorization, session-level CLI consent + retention expiry,
 * `doc.renderable` / OpenCode resume export checks, and snapshot identity as
 * SSR page 1.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const { id } = await context.params;
  if (!id || id.length > 256 || id.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid session id' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  let doc: SessionDoc | undefined;
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    doc = await getSessionDoc(firestore, id);
  } catch (error) {
    logger.error(
      'agent-lcars: failed to load session doc for transcript page:',
      error,
    );
    return NextResponse.json(
      { error: 'Session store unavailable' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  if (!doc) {
    return NextResponse.json(
      { error: 'Session not found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const target = resolveSessionTranscriptTarget(doc);
  if (target.status === 'expired' || target.status === 'revoked') {
    const body: TranscriptPageApiResponse = {
      events: [],
      hasMore: false,
      warning: target.warning,
    };
    return NextResponse.json(body, {
      status: 410,
      headers: NO_STORE_HEADERS,
    });
  }
  if (target.status === 'ineligible') {
    return NextResponse.json(
      { error: 'Transcript unavailable' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const rawCursor = request.nextUrl.searchParams.get('cursor');
  const cursor =
    rawCursor !== null
      ? parseTranscriptCursor(rawCursor, target.agent)
      : undefined;
  if (rawCursor !== null && (!cursor || !cursor.snapshot)) {
    return NextResponse.json(
      { error: 'Invalid transcript cursor' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (cursor && cursor.snapshot !== target.snapshotId) {
    const body: TranscriptPageApiResponse = {
      events: [],
      hasMore: false,
      code: 'snapshot-changed',
      warning:
        'Transcript snapshot changed since this page loaded. Reload to view the updated archive.',
    };
    return NextResponse.json(body, {
      status: 409,
      headers: NO_STORE_HEADERS,
    });
  }

  const page = await getSessionTranscript(
    target.transcriptGcsUri,
    target.agent,
    {
      snapshotId: target.snapshotId,
      maxSingleLineBytes: target.maxSingleLineBytes,
      ...(cursor && { cursor }),
    },
  );
  if (page.storageError) {
    return NextResponse.json(
      {
        error: 'Transcript storage unavailable',
        warning:
          'Failed to load more transcript events from storage. Try again.',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const body: TranscriptPageApiResponse = {
    events: page.events,
    hasMore: Boolean(page.nextCursor),
    ...(page.nextCursor && { nextCursor: page.nextCursor }),
    ...(page.warning && { warning: page.warning }),
  };
  return NextResponse.json(body, { headers: NO_STORE_HEADERS });
}
