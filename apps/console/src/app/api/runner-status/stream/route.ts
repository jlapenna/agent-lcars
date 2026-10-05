import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { subscribeAutoscalerStatuses } from '@/lib/autoscaler-status';
import {
  RUNNER_STATUS_EVENT,
  RUNNER_STATUS_STREAM_LIFETIME_MS,
} from '@/lib/runner-status-contract';

/** Delay the browser waits before reconnecting after a stream ends. */
const RECONNECT_DELAY_MS = 1000;

const encoder = new TextEncoder();

function frame(result: unknown): Uint8Array {
  return encoder.encode(
    `event: ${RUNNER_STATUS_EVENT}\ndata: ${JSON.stringify(result)}\n\n`,
  );
}

/**
 * Server-sent runner status. Each event is a full `AutoscalerStatusResult`,
 * sent for the listener's initial snapshot and for every document change the
 * autoscaler writes (on change, or its heartbeat). Replaces the panel's former
 * 10-second fetch poll of `/api/runner-status`.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Set once the listener is open; `close` may run before that (an early
  // client disconnect), in which case `start` unsubscribes immediately.
  const live: {
    closed: boolean;
    unsubscribe?: () => void;
    lifetime?: ReturnType<typeof setTimeout>;
  } = { closed: false };
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const close = () => {
    if (live.closed) return;
    live.closed = true;
    live.unsubscribe?.();
    if (live.lifetime !== undefined) clearTimeout(live.lifetime);
    request.signal.removeEventListener('abort', close);
    try {
      controllerRef?.close();
    } catch {
      // Already closed by a client disconnect.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      request.signal.addEventListener('abort', close);
      controller.enqueue(encoder.encode(`retry: ${RECONNECT_DELAY_MS}\n\n`));
      // A failed listener reports the unavailable result and stays quiet;
      // the stream still lasts its full lifetime, so a broken store costs one
      // reconnect per lifetime rather than a tight reconnect loop.
      const unsubscribe = await subscribeAutoscalerStatuses((result) => {
        if (!live.closed) controller.enqueue(frame(result));
      });
      if (live.closed) {
        unsubscribe();
        return;
      }
      live.unsubscribe = unsubscribe;
      live.lifetime = setTimeout(close, RUNNER_STATUS_STREAM_LIFETIME_MS);
    },
    cancel: close,
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
