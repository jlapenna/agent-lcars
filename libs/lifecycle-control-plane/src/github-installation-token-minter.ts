import 'server-only';

import { z } from 'zod';

import type {
  InstallationTokenMinter,
  InstallationTokenMintPlan,
  MintResponse,
} from './mint-resolution';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_APP_JWT_LENGTH = 16_384;
const APP_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

const permissionNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/u);
const permissionsSchema = z
  .record(permissionNameSchema, z.enum(['read', 'write']))
  .refine((value) => Object.keys(value).length > 0, 'Permissions are empty');
const credentialProfileIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const profileSchema = z.strictObject({
  credentialProfileId: credentialProfileIdSchema,
  installationId: z.number().int().safe().positive(),
  repositoryId: z.number().int().safe().positive(),
  permissions: permissionsSchema,
});
// GitHub's OpenAPI requires only token/expires_at. Optional echoed scope is
// validated when present, then stripped with every other provider field.
const tokenResponseSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(16_384)
    .regex(/^[A-Za-z0-9_]+$/u),
  expires_at: z.iso
    .datetime({ offset: true })
    .refine((value) => value.endsWith('Z')),
  permissions: permissionsSchema.optional(),
  repository_selection: z.literal('selected').optional(),
  repositories: z
    .array(z.object({ id: z.number().int().safe().positive() }))
    .max(1)
    .optional(),
});

export type GitHubCredentialProfile = z.infer<typeof profileSchema>;

export interface GitHubCredentialProfileResolver {
  resolve(
    plan: InstallationTokenMintPlan,
  ): Promise<GitHubCredentialProfile | undefined>;
}

export interface GitHubAppBearerTokenProvider {
  getToken(): Promise<string>;
}

export class GitHubInstallationTokenMintUnknownError extends Error {
  constructor() {
    super('GitHub installation token mint outcome is unknown');
    this.name = 'GitHubInstallationTokenMintUnknownError';
  }
}

function samePermissions(
  left: Readonly<Record<string, 'read' | 'write'>>,
  right: Readonly<Record<string, 'read' | 'write'>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    throw new GitHubInstallationTokenMintUnknownError();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new GitHubInstallationTokenMintUnknownError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GitHubInstallationTokenMintUnknownError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof GitHubInstallationTokenMintUnknownError) throw error;
    throw new GitHubInstallationTokenMintUnknownError();
  }
}

async function releaseResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A received status still determines issuance semantics. Failure to release
    // transport capacity must not turn a definite rejection into ambiguity.
  }
}

function validPlan(plan: unknown): plan is InstallationTokenMintPlan {
  const value =
    plan !== null && typeof plan === 'object'
      ? (plan as Record<string, unknown>)
      : undefined;
  return (
    value !== undefined &&
    typeof value.installationId === 'number' &&
    Number.isSafeInteger(value.installationId) &&
    value.installationId > 0 &&
    typeof value.repositoryId === 'number' &&
    Number.isSafeInteger(value.repositoryId) &&
    value.repositoryId > 0 &&
    typeof value.credentialProfileId === 'string' &&
    credentialProfileIdSchema.safeParse(value.credentialProfileId).success
  );
}

/**
 * Inactive fixed-origin GitHub REST adapter. It performs exactly one token
 * creation request and never retries or exposes provider response details.
 */
export class GitHubInstallationTokenMinter implements InstallationTokenMinter {
  constructor(
    private readonly profiles: GitHubCredentialProfileResolver,
    private readonly authentication: GitHubAppBearerTokenProvider,
    private readonly request: typeof fetch = fetch,
  ) {}

  async mint(plan: InstallationTokenMintPlan): Promise<MintResponse> {
    if (!validPlan(plan)) return { kind: 'definitely-not-started' };
    const mintPlan = Object.freeze(structuredClone(plan));

    let profile: GitHubCredentialProfile | undefined;
    let appJwt: string;
    try {
      const parsed = profileSchema.safeParse(
        await this.profiles.resolve(mintPlan),
      );
      if (!parsed.success) return { kind: 'definitely-not-started' };
      profile = parsed.data;
      if (
        profile.credentialProfileId !== mintPlan.credentialProfileId ||
        profile.installationId !== mintPlan.installationId ||
        profile.repositoryId !== mintPlan.repositoryId
      ) {
        return { kind: 'definitely-not-started' };
      }
      appJwt = await this.authentication.getToken();
      if (
        typeof appJwt !== 'string' ||
        appJwt.length > MAX_APP_JWT_LENGTH ||
        !APP_JWT.test(appJwt)
      ) {
        return { kind: 'definitely-not-started' };
      }
    } catch {
      return { kind: 'definitely-not-started' };
    }

    let response: Response;
    try {
      response = await this.request(
        `${GITHUB_API_ORIGIN}/app/installations/${mintPlan.installationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${appJwt}`,
            'Content-Type': 'application/json',
            'User-Agent': 'agent-lcars-lifecycle-control-plane',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
          body: JSON.stringify({
            repository_ids: [mintPlan.repositoryId],
            permissions: profile.permissions,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new GitHubInstallationTokenMintUnknownError();
    }

    if (response.status !== 201) {
      await releaseResponse(response);
      if ([401, 403, 404, 422].includes(response.status)) {
        return { kind: 'definitely-not-started' };
      }
      throw new GitHubInstallationTokenMintUnknownError();
    }

    const parsed = tokenResponseSchema.safeParse(await boundedJson(response));
    if (
      !parsed.success ||
      (parsed.data.permissions !== undefined &&
        !samePermissions(parsed.data.permissions, profile.permissions)) ||
      (parsed.data.repositories !== undefined &&
        (parsed.data.repositories.length !== 1 ||
          parsed.data.repositories[0]?.id !== mintPlan.repositoryId))
    ) {
      throw new GitHubInstallationTokenMintUnknownError();
    }
    return {
      kind: 'issued',
      token: parsed.data.token,
      tokenExpiresAt: parsed.data.expires_at,
    };
  }
}
