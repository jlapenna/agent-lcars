import {
  type AgentEvent,
  agentEventsContract,
  type AgentEventSubscriptionRequest,
  type AgentEventSubscriptionView,
  type OutlineSourceReport,
} from '@agent-lcars/work';
import {
  COMMON_ERROR_STATUS_MAP,
  createORPCClient,
  ORPCError,
} from '@orpc/client';
import type { RouterContractClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi/fetch';
import { GoogleAuth } from 'google-auth-library';

import type { LocalErrorCode } from './local-protocol';

/**
 * Forwards a session's subscribe, list and unsubscribe requests to the
 * console's Work API (`/api/work/v1/events/subscriptions`), authenticated
 * with a Google ID token minted from this host's agent-events service
 * account. The console takes the host from that verified identity, so no
 * request carries one.
 */
export type ForwardResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: Exclude<LocalErrorCode, 'not-configured'>;
      readonly message: string;
      /** Whether the same request may succeed later. */
      readonly retryable: boolean;
    };

export interface SubscriptionForwarder {
  subscribe(
    sessionId: string,
    request: AgentEventSubscriptionRequest,
    githubStream?: boolean,
  ): Promise<ForwardResult<AgentEventSubscriptionView>>;
  list(
    sessionId: string | undefined,
  ): Promise<ForwardResult<readonly AgentEventSubscriptionView[]>>;
  unsubscribe(id: string): Promise<ForwardResult<{ readonly id: string }>>;
  reportGithub?(event: AgentEvent): Promise<ForwardResult<SessionReportResult>>;
  reportOutline?(
    report: OutlineSourceReport,
  ): Promise<ForwardResult<SessionReportResult>>;
  observeOutline?(
    documentId: string,
    agentCreated: boolean,
  ): Promise<ForwardResult<{ ok: true }>>;
  fallbackOutline?(deliveryId: string): Promise<ForwardResult<{ ok: true }>>;
  /** Reports that a session on this host went idle or ended. */
  reportSession(
    sessionId: string,
    kind: SessionReportKind,
    occurredAt: string,
  ): Promise<ForwardResult<SessionReportResult>>;
}

export type SessionReportKind = 'idle' | 'ended';
export interface SessionReportResult {
  readonly eventId: string;
  /** Subscriptions the event was published to. */
  readonly delivered: number;
}

export interface WorkApiForwarderDeps {
  /** The console origin, such as `https://lcars.jlapenna.net`. */
  readonly origin: string;
  readonly fetch: typeof fetch;
  /** A Google ID token for the Work API audience. */
  readonly idToken: () => Promise<string>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_CHARS = 300;

type AgentEventsClient = RouterContractClient<typeof agentEventsContract>;

/** The console's own message, bounded and on one line. */
function serverMessage(error: ORPCError<string, unknown>): string | undefined {
  const message = error.message.replace(/\s+/gu, ' ').trim();
  return message ? message.slice(0, MAX_MESSAGE_CHARS) : undefined;
}

/** The HTTP status behind an error: oRPC carries the code its status maps
 * to, and a response that was not an oRPC error (the Work API route's own
 * 403, a proxy's 502) keeps the response it came from. */
export function errorStatus(error: ORPCError<string, unknown>): number {
  const common = (COMMON_ERROR_STATUS_MAP as Record<string, number>)[
    error.code
  ];
  if (common !== undefined) return common;
  const status = (error.data as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : 500;
}

/** Maps a failed call to a local error a CLI can explain. */
export function forwardError(
  error: unknown,
  context: { readonly sessionId?: string } = {},
): Extract<ForwardResult<never>, { ok: false }> {
  if (!(error instanceof ORPCError)) {
    const name = error instanceof Error ? error.name : 'error';
    return {
      ok: false,
      error: 'unavailable',
      message: `could not reach the LCARS console (${name === 'TimeoutError' ? 'timed out' : name})`,
      retryable: true,
    };
  }
  const status = errorStatus(error);
  const said = serverMessage(error);
  switch (status) {
    case 400:
      return {
        ok: false,
        error: 'invalid-request',
        message: said ?? 'the console refused the request as invalid',
        retryable: false,
      };
    case 401:
      return {
        ok: false,
        error: 'unauthorized',
        message:
          "the console refused this host's agent-events identity (401); its key or Work API grant is missing or wrong",
        retryable: false,
      };
    case 403:
      return {
        ok: false,
        error: 'forbidden',
        message:
          said ??
          (context.sessionId === undefined
            ? (said ?? 'the console refused this host (403)')
            : `session ${context.sessionId} is not a live session that LCARS telemetry reports on this host (403)`),
        retryable: false,
      };
    case 404:
      return {
        ok: false,
        error: 'not-found',
        message: 'no such subscription on this host',
        retryable: false,
      };
    case 409:
      return {
        ok: false,
        error: 'conflict',
        message:
          said ??
          'this session has too many subscriptions; remove one with lcars session unsubscribe',
        retryable: false,
      };
    case 503:
      return {
        ok: false,
        error: 'unavailable',
        message: said ?? 'the LCARS console is temporarily unavailable',
        retryable: true,
      };
    default:
      return {
        ok: false,
        error: 'unavailable',
        message: `the LCARS console failed (HTTP ${status})`,
        retryable: status >= 500 || status === 429,
      };
  }
}

export function workApiSubscriptionForwarder(
  deps: WorkApiForwarderDeps,
): SubscriptionForwarder & { readonly client: AgentEventsClient } {
  const link = new OpenAPILink(agentEventsContract, {
    origin: deps.origin,
    url: '/api/work/v1',
    headers: async () => ({ authorization: `Bearer ${await deps.idToken()}` }),
    fetch: deps.fetch,
  });
  const client: AgentEventsClient = createORPCClient(link);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = async <T>(
    run: (signal: AbortSignal) => Promise<T>,
    context: { readonly sessionId?: string } = {},
  ): Promise<ForwardResult<T>> => {
    try {
      return { ok: true, value: await run(AbortSignal.timeout(timeoutMs)) };
    } catch (error) {
      if (error instanceof IdTokenError) {
        return {
          ok: false,
          error: 'unauthorized',
          message: `could not mint an ID token from this host's agent-events key: ${error.message}`,
          retryable: true,
        };
      }
      return forwardError(error, context);
    }
  };
  return {
    client,
    subscribe: (sessionId, request, githubStream) =>
      call(
        (signal) =>
          client.subscribe(
            {
              sessionId,
              ...(githubStream ? { githubStream: true } : {}),
              key: request.key,
              ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
              ...(request.until === undefined ? {} : { until: request.until }),
            },
            { signal },
          ),
        { sessionId },
      ),
    list: (sessionId) =>
      call(async (signal) => {
        const { subscriptions } = await client.list(
          sessionId === undefined ? {} : { sessionId },
          { signal },
        );
        return subscriptions;
      }),
    unsubscribe: (id) =>
      call(async (signal) => {
        const { id: deleted } = await client.unsubscribe({ id }, { signal });
        return { id: deleted };
      }),
    reportGithub: (event) =>
      call((signal) => client.reportGithub({ event }, { signal })),
    reportOutline: (report) =>
      call((signal) => client.reportOutline(report, { signal })),
    observeOutline: (documentId, agentCreated) =>
      call((signal) =>
        client.observeOutline({ documentId, agentCreated }, { signal }),
      ),
    fallbackOutline: (deliveryId) =>
      call((signal) => client.fallbackOutline({ deliveryId }, { signal })),
    reportSession: (sessionId, kind, occurredAt) =>
      call((signal) =>
        client.reportSession({ sessionId, kind, occurredAt }, { signal }),
      ),
  };
}

/** A token could not be minted; distinct from the console refusing one. */
export class IdTokenError extends Error {
  override name = 'IdTokenError';
}

export interface IdTokenClientLike {
  getRequestHeaders(): Promise<Headers>;
}

/**
 * ID tokens for `audience` from a service-account key file. The client is
 * created on first use and caches its token until shortly before it
 * expires.
 */
export function serviceAccountIdTokens(
  keyFilename: string,
  audience: string,
  createClient: (
    keyFilename: string,
    audience: string,
  ) => Promise<IdTokenClientLike> = (file, aud) =>
    new GoogleAuth({ keyFilename: file }).getIdTokenClient(aud),
): () => Promise<string> {
  let client: Promise<IdTokenClientLike> | undefined;
  return async () => {
    try {
      client ??= createClient(keyFilename, audience);
      const headers = await (await client).getRequestHeaders();
      const token = /^Bearer (\S+)$/u.exec(
        headers.get('authorization') ?? '',
      )?.[1];
      if (!token) throw new Error('no ID token in the request headers');
      return token;
    } catch (error) {
      // A failed client (an unreadable key, say) is created again next time.
      client = undefined;
      throw new IdTokenError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}
