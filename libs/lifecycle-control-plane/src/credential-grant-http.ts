import 'server-only';

import type {
  CredentialGrantRequest,
  CredentialGrantResult,
} from '@agent-lcars/dispatch-contracts';
import {
  credentialGrantRequestSchema,
  credentialGrantResultSchema,
} from '@agent-lcars/dispatch-contracts';

import { AuthorityConflict } from './authority-storage';
import {
  CredentialGrantConflict,
  type CredentialGrantCoordinator,
  type VerifiedWorkerGrantOidc,
  type WorkerGrantOidcBoundary,
} from './credential-grant-oidc';
import { WorkerGrantJwtUnavailableError } from './github-worker-grant-oidc-verifier';

const MAX_REQUEST_BYTES = 4_096;
const MAX_JWT_LENGTH = 16_384;
const BEARER_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;

type GrantHttpErrorCode =
  | 'method_not_allowed'
  | 'invalid_request'
  | 'invalid_token'
  | 'conflict'
  | 'service_unavailable';

interface WorkerGrantVerificationBoundary {
  verify(raw: unknown): Promise<VerifiedWorkerGrantOidc>;
}

interface CredentialGrantIssueService {
  issue(input: {
    request: CredentialGrantRequest;
    verified: VerifiedWorkerGrantOidc;
  }): Promise<CredentialGrantResult>;
}

class InvalidGrantHttpRequest extends Error {}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: GrantHttpErrorCode,
  headers?: Readonly<Record<string, string>>,
) {
  return jsonResponse(
    status,
    {
      schema: 'agent-lcars.credential-grant-error/v1',
      version: 1,
      code,
    },
    headers,
  );
}

async function boundedUtf8Body(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_REQUEST_BYTES
    ) {
      throw new InvalidGrantHttpRequest();
    }
  }

  const reader = request.body?.getReader();
  if (reader === undefined) throw new InvalidGrantHttpRequest();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new InvalidGrantHttpRequest();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InvalidGrantHttpRequest) throw error;
    throw new InvalidGrantHttpRequest();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidGrantHttpRequest();
  }
}

async function parsedRequest(
  request: Request,
): Promise<CredentialGrantRequest> {
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json')
    throw new InvalidGrantHttpRequest();
  let value: unknown;
  try {
    value = JSON.parse(await boundedUtf8Body(request));
  } catch {
    throw new InvalidGrantHttpRequest();
  }
  const parsed = credentialGrantRequestSchema.safeParse(value);
  if (!parsed.success) throw new InvalidGrantHttpRequest();
  return Object.freeze(parsed.data);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization');
  if (
    authorization === null ||
    authorization.length > MAX_JWT_LENGTH + 'Bearer '.length
  ) {
    throw new InvalidGrantHttpRequest();
  }
  const match = BEARER_JWT.exec(authorization);
  if (match === null) throw new InvalidGrantHttpRequest();
  return match[1];
}

/**
 * Inactive transport adapter. A future Next route may delegate one Request to
 * this handler only after production storage/minter/tenant composition is
 * separately approved. This class owns no dependency selection or logging.
 */
export class CredentialGrantHttpHandler {
  constructor(
    private readonly oidc: WorkerGrantVerificationBoundary,
    private readonly grants: CredentialGrantIssueService,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', { Allow: 'POST' });
    }

    let grantRequest: CredentialGrantRequest;
    let token: string;
    try {
      grantRequest = await parsedRequest(request);
      token = bearerToken(request);
    } catch {
      return errorResponse(400, 'invalid_request');
    }

    let verified: VerifiedWorkerGrantOidc;
    try {
      verified = await this.oidc.verify(token);
    } catch (error) {
      if (error instanceof WorkerGrantJwtUnavailableError) {
        return errorResponse(503, 'service_unavailable');
      }
      return errorResponse(401, 'invalid_token', {
        'WWW-Authenticate': 'Bearer realm="agent-lcars-credential-grant"',
      });
    }

    try {
      const result = credentialGrantResultSchema.safeParse(
        await this.grants.issue({ request: grantRequest, verified }),
      );
      if (!result.success) return errorResponse(503, 'service_unavailable');
      return jsonResponse(200, result.data);
    } catch (error) {
      if (
        error instanceof AuthorityConflict ||
        error instanceof CredentialGrantConflict
      ) {
        return errorResponse(409, 'conflict');
      }
      return errorResponse(503, 'service_unavailable');
    }
  }
}

export type CredentialGrantHttpOidcBoundary = Pick<
  WorkerGrantOidcBoundary,
  'verify'
>;
export type CredentialGrantHttpIssueService = Pick<
  CredentialGrantCoordinator,
  'issue'
>;
