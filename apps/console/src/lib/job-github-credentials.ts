import 'server-only';

import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';

import { jobProfileNameSchema } from './repository-job-definition';

const login = z.string().regex(/^[a-zA-Z0-9-]{1,39}$/u);
const sources = z.record(
  jobProfileNameSchema,
  z.strictObject({
    login,
    secretVersion: z
      .string()
      .regex(
        /^projects\/[a-zA-Z0-9-]+\/secrets\/[a-zA-Z0-9_-]+\/versions\/(?:latest|[1-9][0-9]*)$/u,
      ),
  }),
);
const credentialSchema = z.strictObject({
  token: z.string().min(1).max(1024).regex(/^\S+$/u),
  expiresAt: z.iso.datetime().nullable(),
});
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

export function jobGithubCredentialSources() {
  try {
    return sources.parse(
      JSON.parse(process.env['AGENT_LCARS_JOB_GITHUB_CREDENTIALS'] ?? '{}'),
    );
  } catch {
    throw new Error('Invalid AGENT_LCARS_JOB_GITHUB_CREDENTIALS');
  }
}

interface CredentialPorts {
  sources: ReturnType<typeof jobGithubCredentialSources>;
  readSecret: (version: string) => Promise<string>;
  readLogin: (token: string) => Promise<string>;
}
async function readSecret(version: string): Promise<string> {
  const client = await auth.getClient();
  const response = await client.request<{ payload?: { data?: string } }>({
    url: `https://secretmanager.googleapis.com/v1/${version}:access`,
    method: 'GET',
    timeout: 10000,
    retry: false,
  });
  const data = response.data.payload?.data;
  if (!data || data.length > 8192)
    throw new Error('Invalid credential payload');
  return Buffer.from(data, 'base64').toString('utf8');
}
async function readLogin(token: string): Promise<string> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('GitHub credential refused');
  return login.parse((await response.json()).login);
}

/** Called only after live run + pinned occurrence authorization. Never cache
 * token values in Work, profiles, browser responses, or application logs. */
export async function resolveJobGithubCredential(
  name: string,
  now: Date,
  ports: CredentialPorts = {
    sources: jobGithubCredentialSources(),
    readSecret,
    readLogin,
  },
): Promise<{
  token: string;
  expiresAt: string | null;
  refreshAt: string;
  login: string;
}> {
  const source = Object.hasOwn(ports.sources, name)
    ? ports.sources[name]
    : undefined;
  if (!source)
    throw new Error(`GitHub credential set ${name} is not configured`);
  // Authenticated-client errors can contain request headers and secret payloads.
  // Replace them at this boundary, before the API handler can log/serialize them.
  try {
    const credential = credentialSchema.parse(
      JSON.parse(await ports.readSecret(source.secretVersion)),
    );
    if (
      credential.expiresAt !== null &&
      Date.parse(credential.expiresAt) <= now.getTime() + 60000
    )
      throw new Error('Expired credential');
    if (
      (await ports.readLogin(credential.token)).toLowerCase() !==
      source.login.toLowerCase()
    )
      throw new Error('Unexpected GitHub identity');
    return {
      ...credential,
      login: source.login,
      refreshAt: new Date(
        Math.min(
          credential.expiresAt === null
            ? Number.POSITIVE_INFINITY
            : Date.parse(credential.expiresAt),
          now.getTime() + 300000,
        ),
      ).toISOString(),
    };
  } catch {
    throw new Error(
      `GitHub credential set ${name} is unavailable, expired, or has the wrong identity`,
    );
  }
}
