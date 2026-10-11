import 'server-only';

import {
  getAgentTelemetryReaderFirestore,
  getSessionDoc,
  upsertSession,
} from '@agent-lcars/telemetry/server';

import { auth } from '@/auth';
import {
  controlPlaneRepositories,
  controlPlaneRepository,
} from '@/lib/deployment';
import {
  githubActionsWorkSubject,
  verifySessionExpiryOidcToken,
  verifyWorkApiOidcToken,
} from '@/lib/github-actions-oidc';
import { resolveTelemetryHostToken } from '@/lib/telemetry-host-tokens';
import {
  handleSessionEventRequest,
  type TelemetryWriterPrincipal,
} from '@/lib/telemetry-ingest';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants } from '@/lib/work-grants';

const verifyGoogleIdToken = googleIdTokenVerifier(
  process.env['AGENT_LCARS_WORK_AUDIENCE'] ?? 'agent-lcars-work',
);

/**
 * Hook telemetry ingest (docs/hooks-telemetry-design.md §4.4). A host token
 * (workstation `lcars hook` client) or a Work-grant identity holding
 * `telemetry.writer` (the runner's telemetry-writer service account) posts
 * one `SessionEventV1`; the handler turns it into the same `sessions/{id}`
 * doc the watcher daemon writes. Gated off by default until phase 0.
 */
async function authenticate(
  request: Request,
  bearer: string,
): Promise<TelemetryWriterPrincipal | undefined> {
  const host = resolveTelemetryHostToken(bearer);
  if (host !== undefined) {
    return { principal: `host:${host}`, boundHost: host, allowRunner: false };
  }
  const principal = await authenticateWorkRequest(request, {
    verifyGoogleIdToken,
    verifySessionExpiryOidcToken: (token) =>
      verifySessionExpiryOidcToken(token, controlPlaneRepository()),
    verifyGithubActionsWorkOidcToken: async (token) => {
      const identity = await verifyWorkApiOidcToken(
        token,
        controlPlaneRepositories(),
      );
      return {
        repository: identity.repository,
        subject: githubActionsWorkSubject(identity.repository),
      };
    },
    session: async () => (await auth()) as { user?: { login?: string } } | null,
    grants: workGrants,
  });
  if (!principal || !principal.scopes.has('telemetry.writer')) return undefined;
  return {
    principal: principal.principal,
    allowRunner: principal.via === 'google',
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return handleSessionEventRequest(request, sessionId, {
    enabled: () => process.env['AGENT_LCARS_TELEMETRY_INGEST'] === '1',
    authenticate,
    readSessionDoc: async (id) =>
      getSessionDoc(await getAgentTelemetryReaderFirestore(), id),
    writeSession: upsertSession,
    now: () => new Date().toISOString(),
  });
}
