import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { validateSubscriptionRequest } from '@agent-lcars/work';

import type { DeliveryLog } from './delivery-agent';
import {
  type LocalRequest,
  localRequestSchema,
  type LocalResponse,
  MAX_LOCAL_LINE_BYTES,
} from './local-protocol';
import type { SubscriptionForwarder } from './subscribe-forwarder';

/** A request that has not finished arriving by then is dropped. */
const REQUEST_READ_TIMEOUT_MS = 5_000;

export type LocalRequestOutcome = 'ok' | LocalResponseError;
type LocalResponseError = Extract<LocalResponse, { ok: false }>['error'];

/**
 * Answers one local request. Without a forwarder (no agent-events key on
 * this host) every valid request is refused as `not-configured`, so the CLI
 * can say why instead of timing out.
 */
export async function handleLocalRequest(
  raw: unknown,
  forwarder: SubscriptionForwarder | undefined,
): Promise<{ request?: LocalRequest; response: LocalResponse }> {
  const parsed = localRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: {
        ok: false,
        error: 'invalid-request',
        message: 'not a request this events agent understands',
      },
    };
  }
  const request = parsed.data;
  if (request.op === 'subscribe') {
    // Checked again here: the agent is the boundary, not the CLI.
    const validated = validateSubscriptionRequest(request);
    if (!validated.ok) {
      return {
        request,
        response: {
          ok: false,
          error: 'invalid-request',
          message: validated.error,
        },
      };
    }
  }
  if (!forwarder) {
    return {
      request,
      response: {
        ok: false,
        error: 'not-configured',
        message:
          'the events agent on this host has no agent-events key, so it cannot reach LCARS',
      },
    };
  }
  switch (request.op) {
    case 'subscribe': {
      const result = await forwarder.subscribe(request.sessionId, {
        key: request.key,
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        ...(request.until === undefined ? {} : { until: request.until }),
      });
      return {
        request,
        response: result.ok
          ? { ok: true, subscription: result.value }
          : { ok: false, error: result.error, message: result.message },
      };
    }
    case 'list': {
      const result = await forwarder.list(request.sessionId);
      return {
        request,
        response: result.ok
          ? { ok: true, subscriptions: [...result.value] }
          : { ok: false, error: result.error, message: result.message },
      };
    }
    case 'unsubscribe': {
      const result = await forwarder.unsubscribe(request.id);
      return {
        request,
        response: result.ok
          ? { ok: true, deleted: result.value.id }
          : { ok: false, error: result.error, message: result.message },
      };
    }
  }
}

export interface EventsSocketServer {
  close(): Promise<void>;
}

/**
 * Prepares the socket's directory: created mode 0700, and refused unless it
 * is a real directory this user owns that nobody else can enter. That
 * directory is what keeps other users off the socket.
 */
export function prepareSocketDirectory(
  directory: string,
  uid: number | null = process.getuid?.() ?? null,
): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`${directory} is not a directory`);
  }
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`${directory} belongs to another user`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

function probe(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Removes a socket left by an agent that stopped; refuses to take over a
 * live one or to delete anything that is not a socket. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!stat.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket`);
  }
  if (await probe(socketPath)) {
    throw new Error(`another events agent is listening on ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

/**
 * Serves the local subscribe socket: one JSON request line per connection,
 * one JSON response line back.
 */
export async function serveEventsSocket(
  socketPath: string,
  handle: (raw: unknown) => Promise<LocalResponse>,
  log: DeliveryLog,
): Promise<EventsSocketServer> {
  prepareSocketDirectory(path.dirname(socketPath));
  await clearStaleSocket(socketPath);
  const server = net.createServer((socket) => {
    let received = '';
    let answered = false;
    socket.setEncoding('utf8');
    socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => {
      if (!answered) socket.destroy();
    });
    const answer = (response: LocalResponse) => {
      answered = true;
      socket.setTimeout(0);
      socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.on('data', (chunk: string) => {
      if (answered) return;
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) {
        if (received.length > MAX_LOCAL_LINE_BYTES) {
          answer({
            ok: false,
            error: 'invalid-request',
            message: 'request too large',
          });
        }
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(received.slice(0, end));
      } catch {
        answer({
          ok: false,
          error: 'invalid-request',
          message: 'request is not JSON',
        });
        return;
      }
      answered = true;
      socket.setTimeout(0);
      void handle(raw)
        .catch((error: unknown): LocalResponse => {
          log({
            level: 'error',
            msg: 'local request crashed',
            error: error instanceof Error ? error.name : 'error',
          });
          return {
            ok: false,
            error: 'unavailable',
            message: 'the events agent failed to handle the request',
          };
        })
        .then((response) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        });
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // The directory already keeps other users out; this is the second lock.
  fs.chmodSync(socketPath, 0o600);
  log({
    level: 'info',
    msg: 'local subscribe socket open',
    socket: socketPath,
  });
  return {
    // Closing a Unix socket server removes its socket file.
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
