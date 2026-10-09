import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { subscribeDashboardChanges } from '@/lib/dashboard-stream';
import {
  DASHBOARD_EVENT,
  DASHBOARD_HEARTBEAT_MS,
  DASHBOARD_REFRESH_INTERVAL_MS,
  DASHBOARD_STREAM_LIFETIME_MS,
  type DashboardSignal,
} from '@/lib/dashboard-stream-contract';

const encoder = new TextEncoder();

/** Admin-only invalidations reuse the runner-status stream lifecycle. No
 * projection contents cross this boundary; the normal RSC/Work reads retain
 * their repository and operator authorization. */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let flush: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let state: DashboardSignal['state'] = 'degraded';
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    clearTimeout(lifetime);
    clearInterval(heartbeat);
    clearTimeout(flush);
    request.signal.removeEventListener('abort', close);
    try {
      controllerRef?.close();
    } catch {
      /* Client already left. */
    }
  };
  const send = (signal: DashboardSignal) => {
    if (closed) return;
    controllerRef?.enqueue(
      encoder.encode(
        `event: ${DASHBOARD_EVENT}\ndata: ${JSON.stringify(signal)}\n\n`,
      ),
    );
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener('abort', close);
      // Start the bound BEFORE asynchronous listener setup, including failures.
      lifetime = setTimeout(close, DASHBOARD_STREAM_LIFETIME_MS);
      const stop = await subscribeDashboardChanges((signal) => {
        if (closed) return;
        state = signal.state;
        if (!signal.changed) {
          send(signal);
          return;
        }
        // Transaction bursts and telemetry heartbeats cost one refresh per
        // five seconds at most, rather than a request per changed document.
        flush ??= setTimeout(() => {
          flush = undefined;
          send({ state, changed: true });
        }, DASHBOARD_REFRESH_INTERVAL_MS);
      });
      if (closed) {
        stop();
        return;
      }
      unsubscribe = stop;
      heartbeat = setInterval(
        () => send({ state, changed: false }),
        DASHBOARD_HEARTBEAT_MS,
      );
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
