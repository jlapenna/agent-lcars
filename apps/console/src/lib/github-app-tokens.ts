import 'server-only';

import { createPrivateKey, type KeyObject } from 'node:crypto';

import { SignJWT } from 'jose';

import { controlPlaneRepository } from './deployment';

/**
 * Per-repo GitHub token resolution for the outbox drain (`orchestrator-
 * dispatch.ts`).
 *
 * Today every GitHub effect the drain performs -- `workflow_dispatch`,
 * issue comments, the `needs-human` label -- uses one ambient token
 * (`AGENT_LCARS_GITHUB_TOKEN`), which is only ever proven installed against
 * the home repo. Issue #1190 generalizes dispatch to foreign repos (the
 * `supersprinklesracing` fleet, eventually homelab); an ambient PAT scoped
 * to the home repo cannot act there. `DispatchTokenProvider` is the seam
 * that lets the drain ask for "a token good for this repo" without caring
 * whether that means the one static ambient token or a freshly minted,
 * narrowly scoped GitHub App installation token.
 *
 * `createDispatchTokenProvider` is wired into `orchestrator-runtime.ts` and
 * has been live in production since 2026-08-16 (#1245 wired the two
 * `AGENT_LCARS_APP_*` env vars into `apphosting.yaml`): with both set, the
 * home repo (`controlPlaneRepository()`) keeps using the ambient token and
 * every other repo mints a scoped GitHub App installation token. With
 * either unset it still returns exactly the same `AmbientTokenProvider`
 * this repo has always used, for every repo, so nothing observably changes.
 */

/** GitHub's REST API base for both the installation lookup and the
 * access-token mint below. */
const GITHUB_API = 'https://api.github.com';

/** A GitHub App JWT (used only to mint installation access tokens) is
 * capped at 10 minutes by GitHub. 9 minutes leaves headroom before that
 * ceiling even after the clock-skew backdating below. */
const JWT_LIFETIME_SECONDS = 9 * 60;

/** GitHub's own recommendation for App JWTs: backdate `iat` by up to a
 * minute so a JWT minted a moment before the request reaches GitHub isn't
 * rejected as "not yet valid" by clock drift between this host and
 * GitHub's. */
const JWT_CLOCK_SKEW_SECONDS = 60;

/** Installation access tokens are normally valid for an hour; refresh
 * this long before actual expiry so a token already in flight to a caller
 * is never handed out moments before GitHub would reject it. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface DispatchTokenProvider {
  /** Resolves a bearer token usable for GitHub REST calls against `repo`
   *  (`owner/name`). May reject -- callers treat that the same as a failed
   *  GitHub call (see `orchestrator-dispatch.ts`'s try/catch around each
   *  fetch). */
  tokenFor(repo: string): Promise<string>;
}

/** Today's behavior: one static token, good for every repo it's actually
 * installed against. */
export class AmbientTokenProvider implements DispatchTokenProvider {
  constructor(private readonly token: string) {}

  tokenFor(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

export interface AppInstallationTokenProviderOptions {
  /** The GitHub App's client ID -- used as the JWT `iss` claim. */
  clientId: string;
  /** The GitHub App's private key, PEM-encoded. Both PKCS1
   *  (`-----BEGIN RSA PRIVATE KEY-----`, the format GitHub hands you on
   *  download) and PKCS8 (`-----BEGIN PRIVATE KEY-----`) are accepted --
   *  see `parsePrivateKey`. Never logged or included in any thrown error. */
  privateKeyPem: string;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Mints short-lived, narrowly-scoped GitHub App installation tokens, one
 * per repo, on demand: sign an App JWT, resolve that repo's installation
 * id, exchange it for an access token scoped to just that repository with
 * `actions:write` + `issues:write` (exactly what the drain needs and
 * nothing more). Tokens are cached per repo until close to their expiry, so
 * a burst of drains against the same repo mints once, not once per call.
 *
 * `tokenFor` throws (never returns a partial/placeholder token) on any
 * failure, with a message describing what step failed and against which
 * repo -- never the JWT or the private key themselves.
 */
export class AppInstallationTokenProvider implements DispatchTokenProvider {
  private readonly cache = new Map<string, CachedInstallationToken>();

  constructor(private readonly options: AppInstallationTokenProviderOptions) {}

  async tokenFor(repo: string): Promise<string> {
    const cached = this.cache.get(repo);
    if (
      cached !== undefined &&
      Date.now() < cached.expiresAtMs - TOKEN_REFRESH_BUFFER_MS
    ) {
      return cached.token;
    }

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const jwt = await mintAppJwt(
      this.options.clientId,
      this.options.privateKeyPem,
    );
    const installationId = await resolveInstallationId(fetchImpl, jwt, repo);
    const minted = await mintInstallationAccessToken(
      fetchImpl,
      jwt,
      installationId,
      repo,
    );
    this.cache.set(repo, minted);
    return minted.token;
  }
}

/** Routes to `home`'s provider for the control plane's own repo and to
 * `foreign`'s provider for everything else. */
class CompositeTokenProvider implements DispatchTokenProvider {
  constructor(
    private readonly homeRepo: string,
    private readonly home: DispatchTokenProvider,
    private readonly foreign: DispatchTokenProvider,
  ) {}

  tokenFor(repo: string): Promise<string> {
    return (repo === this.homeRepo ? this.home : this.foreign).tokenFor(repo);
  }
}

/**
 * Builds the token provider the outbox drain should use, from environment
 * configuration:
 *
 * - `AGENT_LCARS_APP_CLIENT_ID` and `AGENT_LCARS_APP_PRIVATE_KEY` both set
 *   -> a composite: the home repo (`controlPlaneRepository()`) keeps using
 *   the ambient token exactly as before, every other repo mints a scoped
 *   GitHub App installation token. The private key is parse-validated
 *   *here*, eagerly, before either provider is constructed -- see the
 *   note below.
 * - either unset -> `AmbientTokenProvider` for every repo, byte-identical
 *   to the pre-#1190 behavior.
 *
 * `AGENT_LCARS_GITHUB_TOKEN` is required in both cases -- the home repo
 * always uses it, App-mode or not.
 *
 * This function is called lazily, once per outbox drain (see
 * `orchestrator-runtime.ts`'s `drain: () => drainOutbox({ ...,
 * tokens: createDispatchTokenProvider(process.env) })`), not once at
 * process startup. Validating the key here still fails far earlier than
 * the pre-#1276 behavior: `AppInstallationTokenProvider.tokenFor` only
 * ever parsed the key lazily, inside `mintAppJwt`, the first time a
 * *foreign*-repo dispatch actually drained -- home-repo traffic never
 * touches the App path, so a malformed key (e.g. GitHub's own PKCS1
 * download format, before #1276) was a silent, foreign-repo-only outage.
 * Throwing here instead means the very first drain after a bad key is
 * deployed fails loudly and immediately, for every repo, before any
 * dispatch is attempted -- surfaced via each HTTP route's `internalError`
 * `console.error` (`orchestrator-routes.ts`) or the console server
 * action's own error path, whichever reaches a drain first. In practice
 * that is within `dispatch-reconcile.yml`'s cron window (`7,37 * * * *`,
 * so at most ~30 minutes after deploy) if nothing else drains sooner.
 */
export function createDispatchTokenProvider(
  env: Record<string, string | undefined>,
): DispatchTokenProvider {
  const ambientToken = env['AGENT_LCARS_GITHUB_TOKEN'];
  if (ambientToken === undefined) {
    throw new Error('process.env.AGENT_LCARS_GITHUB_TOKEN not defined');
  }
  const ambient = new AmbientTokenProvider(ambientToken);

  const clientId = env['AGENT_LCARS_APP_CLIENT_ID'];
  const privateKeyPem = env['AGENT_LCARS_APP_PRIVATE_KEY'];
  if (clientId === undefined || privateKeyPem === undefined) {
    return ambient;
  }

  // Eagerly parse-validate: throws the same redacted error `mintAppJwt`
  // would throw on first use, but at construction time instead of at the
  // first foreign-repo dispatch. See the doc comment above.
  parsePrivateKey(privateKeyPem);

  const appProvider = new AppInstallationTokenProvider({
    clientId,
    privateKeyPem,
  });
  return new CompositeTokenProvider(
    controlPlaneRepository(),
    ambient,
    appProvider,
  );
}

/**
 * Parses a GitHub App private key PEM into a key usable for RS256 signing.
 * `node:crypto`'s `createPrivateKey` auto-detects the PEM label, so both
 * PKCS1 (`-----BEGIN RSA PRIVATE KEY-----`, the format GitHub's own "Generate
 * a private key" button downloads -- see #1276) and PKCS8
 * (`-----BEGIN PRIVATE KEY-----`) parse the same way; no PKCS8 re-export is
 * needed since jose's `SignJWT.sign` accepts a Node `KeyObject` directly
 * (jose 6's `KeyInput` union -- see `jose/dist/types/types.d.ts`).
 *
 * Deliberately never includes the underlying parse error in the thrown
 * message: both `node:crypto`'s OpenSSL-backed decoder error and jose's own
 * PEM parse failures can echo back fragments of the input they failed to
 * parse.
 */
function parsePrivateKey(privateKeyPem: string): KeyObject {
  try {
    return createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch {
    throw new Error(
      'GitHub App private key is not a valid PEM-encoded RSA private key (PKCS1 or PKCS8)',
    );
  }
}

async function mintAppJwt(
  clientId: string,
  privateKeyPem: string,
): Promise<string> {
  const key = parsePrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  try {
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(clientId)
      .setIssuedAt(now - JWT_CLOCK_SKEW_SECONDS)
      .setExpirationTime(now + JWT_LIFETIME_SECONDS)
      .sign(key);
  } catch {
    throw new Error('failed to sign GitHub App JWT');
  }
}

function appAuthHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

/** `owner/name` -> `{ owner, name }`. Throws (naming the malformed repo,
 * which is not secret) rather than silently minting a token for the wrong
 * repository. */
function splitRepo(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) {
    throw new Error(
      `invalid repo ${JSON.stringify(repo)}: expected "owner/name"`,
    );
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

async function resolveInstallationId(
  fetchImpl: typeof fetch,
  jwt: string,
  repo: string,
): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/repos/${repo}/installation`, {
      headers: appAuthHeaders(jwt),
    });
  } catch (error) {
    throw new Error(
      `failed to resolve GitHub App installation for ${repo}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `failed to resolve GitHub App installation for ${repo}: GitHub returned ${response.status}`,
    );
  }

  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== 'number') {
    throw new Error(
      `GitHub App installation lookup for ${repo} returned no installation id`,
    );
  }
  return body.id;
}

async function mintInstallationAccessToken(
  fetchImpl: typeof fetch,
  jwt: string,
  installationId: number,
  repo: string,
): Promise<CachedInstallationToken> {
  const { name } = splitRepo(repo);

  let response: Response;
  try {
    response = await fetchImpl(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: appAuthHeaders(jwt),
        body: JSON.stringify({
          repositories: [name],
          permissions: { actions: 'write', issues: 'write' },
        }),
      },
    );
  } catch (error) {
    throw new Error(
      `failed to mint GitHub App installation access token for ${repo}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `failed to mint GitHub App installation access token for ${repo}: GitHub returned ${response.status}`,
    );
  }

  const body = (await response.json()) as {
    token?: unknown;
    expires_at?: unknown;
  };
  if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
    throw new Error(
      `GitHub App installation access token response for ${repo} is missing token/expires_at`,
    );
  }
  const expiresAtMs = Date.parse(body.expires_at);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(
      `GitHub App installation access token response for ${repo} has an unparseable expires_at`,
    );
  }
  return { token: body.token, expiresAtMs };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
