import 'server-only';

import { createPrivateKey, type KeyObject } from 'node:crypto';

import { SignJWT } from 'jose';

/**
 * Per-repo GitHub token resolution for both the outbox drain
 * (`orchestrator-dispatch.ts`) and the console's own singleton Octokit
 * client (`github-client.ts`'s `getGithubClient()`).
 *
 * Through #1245 every GitHub effect either caller performed rode one
 * long-lived ambient token (`AGENT_LCARS_GITHUB_TOKEN`, a classic PAT
 * scoped `repo` against the whole `jlapenna` account) -- installed only
 * against the home repo for the drain, and used unconditionally by
 * `getGithubClient()`. #1190 generalized outbox dispatch to foreign repos
 * (the `supersprinklesracing` fleet, `jlapenna/homelab`); an ambient PAT
 * cannot act there. #1284 finishes the retirement the 2026-08-16 PAT audit
 * (#1204) deferred: `AGENT_LCARS_GITHUB_TOKEN` is gone from both call
 * sites, every repo (home included) now mints a short-lived, per-repo
 * GitHub App installation token, and `AmbientTokenProvider` /
 * `CompositeTokenProvider` -- the byte-identical-fallback and home/foreign
 * routing machinery that made the cutover gradual and reversible -- are
 * deleted now that nothing selects the ambient path anymore.
 *
 * `DispatchTokenProvider` remains the seam that lets a caller ask for "a
 * token good for this repo" without caring how it's minted.
 * `createDispatchTokenProvider` (below) builds the drain's own narrowly
 * scoped (`actions:write`, `issues:write`) provider;
 * `createGithubClientAuthStrategy` (below) wraps a second, more broadly
 * scoped provider in the shape Octokit's own `authStrategy` constructor
 * option expects, for `getGithubClient()`'s singleton client, which serves
 * requests across every watched repo/owner from one Octokit instance and so
 * must resolve auth per-request rather than once at construction.
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

/** The permission set `AppInstallationTokenProvider` requests when minting
 * a repo's installation token, absent an explicit `permissions` option --
 * exactly what the outbox drain needs (`workflow_dispatch`, issue
 * comments, the `needs-human` label) and nothing more. `github-client.ts`
 * passes its own, broader set instead (see `createGithubClientAuthStrategy`
 * below): a token's `permissions` is a request for a *subset* of the App's
 * own granted permissions, never a way to exceed them, so each caller
 * requesting only what it actually uses keeps every minted token as
 * narrowly scoped as its purpose allows. */
const DEFAULT_PERMISSIONS: Record<string, string> = {
  actions: 'write',
  issues: 'write',
};

export interface AppInstallationTokenProviderOptions {
  /** The GitHub App's client ID -- used as the JWT `iss` claim. */
  clientId: string;
  /** The GitHub App's private key, PEM-encoded. Both PKCS1
   *  (`-----BEGIN RSA PRIVATE KEY-----`, the format GitHub hands you on
   *  download) and PKCS8 (`-----BEGIN PRIVATE KEY-----`) are accepted --
   *  see `parsePrivateKey`. Never logged or included in any thrown error. */
  privateKeyPem: string;
  /** The permission set requested for every token this instance mints --
   *  see {@link DEFAULT_PERMISSIONS}'s doc comment for why this is
   *  injectable rather than a single fleet-wide constant. Requesting a
   *  permission the App itself was never granted fails the mint call
   *  outright (for every repo, not just the one call site that needed it),
   *  so this must stay a subset of the App's actual manifest -- see
   *  `github-client.ts`'s own `CONSOLE_GITHUB_CLIENT_PERMISSIONS` for the
   *  audit trail behind that specific set. */
  permissions?: Record<string, string>;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Mints short-lived GitHub App installation tokens, one per repo, on
 * demand: sign an App JWT, resolve that repo's installation id, exchange
 * it for an access token scoped to just that repository with this
 * instance's `permissions` (see {@link DEFAULT_PERMISSIONS}). Tokens are
 * cached per repo until close to their expiry, so a burst of calls against
 * the same repo mints once, not once per call.
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
      this.options.permissions ?? DEFAULT_PERMISSIONS,
    );
    this.cache.set(repo, minted);
    return minted.token;
  }

  /** Drops `repo`'s cached token, forcing the next `tokenFor(repo)` call to
   *  mint fresh rather than serve a token GitHub has already rejected --
   *  `createGithubClientAuthStrategy`'s sole use, on a 401 response (see its
   *  doc comment for why that's the one response code safe to retry
   *  regardless of HTTP method). A no-op when `repo` isn't cached, so a
   *  caller never needs to check first. */
  invalidate(repo: string): void {
    this.cache.delete(repo);
  }
}

/**
 * Builds the token provider the outbox drain should use, from environment
 * configuration: `AGENT_LCARS_APP_CLIENT_ID` and `AGENT_LCARS_APP_PRIVATE_KEY`
 * must both be set -- every repo, including the home repo
 * (`controlPlaneRepository()`), mints a scoped GitHub App installation
 * token. There is no more ambient-token fallback (see this file's top
 * comment): #1284 retired `AmbientTokenProvider`/`CompositeTokenProvider`
 * once nothing selected the ambient path in production anymore.
 *
 * This function is called lazily, once per outbox drain (see
 * `orchestrator-runtime.ts`'s `drain: () => drainOutbox({ ...,
 * tokens: createDispatchTokenProvider(process.env) })`), not once at
 * process startup. The private key is still parse-validated *here*,
 * eagerly, before the provider is constructed: `AppInstallationTokenProvider
 * .tokenFor` only ever parses the key lazily, inside `mintAppJwt`, the
 * first time some repo's dispatch actually drains, so a malformed key
 * (e.g. GitHub's own PKCS1 download format, before #1276) would otherwise
 * be a silent outage until the first drain attempt. Throwing here instead
 * means the very first drain after a bad key is deployed fails loudly and
 * immediately, for every repo, before any dispatch is attempted --
 * surfaced via each HTTP route's `internalError` `console.error`
 * (`orchestrator-routes.ts`) or the console server action's own error
 * path, whichever reaches a drain first. In practice that is within
 * `dispatch-reconcile.yml`'s cron window (`7,37 * * * *`, so at most ~30
 * minutes after deploy) if nothing else drains sooner.
 */
export function createDispatchTokenProvider(
  env: Record<string, string | undefined>,
): DispatchTokenProvider {
  const clientId = env['AGENT_LCARS_APP_CLIENT_ID'];
  if (clientId === undefined) {
    throw new Error('process.env.AGENT_LCARS_APP_CLIENT_ID not defined');
  }
  const privateKeyPem = env['AGENT_LCARS_APP_PRIVATE_KEY'];
  if (privateKeyPem === undefined) {
    throw new Error('process.env.AGENT_LCARS_APP_PRIVATE_KEY not defined');
  }

  // Eagerly parse-validate: throws the same redacted error `mintAppJwt`
  // would throw on first use, but at construction time instead of at the
  // first dispatch. See the doc comment above.
  parsePrivateKey(privateKeyPem);

  return new AppInstallationTokenProvider({ clientId, privateKeyPem });
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
  permissions: Record<string, string>,
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
          permissions,
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

// --- getGithubClient()'s Octokit authStrategy -----------------------------
//
// Everything below wires an `AppInstallationTokenProvider` into Octokit's
// own `authStrategy` constructor option, for `github-client.ts`'s singleton
// `getGithubClient()`. Unlike the outbox drain (every `tokenFor(repo)` call
// site above already knows its target repo directly), one Octokit instance
// here serves reads and mutations across every watched repo -- multiple
// owners -- so auth must be resolved per request, inside an Octokit `auth`
// hook, not once at construction.

/** The subset of an Octokit request's merged endpoint options this module
 *  actually reads. Deliberately not `@octokit/types`' `EndpointDefaults`:
 *  that type isn't a direct dependency of this workspace (only reachable
 *  transitively through `@octokit/rest`), and every field this file touches
 *  is untyped/optional there anyway (`RequestParameters`' own index
 *  signature is `[parameter: string]: unknown`) -- a local, minimal shape
 *  is both accurate and dependency-clean. */
interface RequestEndpointOptions {
  method?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
  owner?: unknown;
  repo?: unknown;
  variables?: unknown;
  [key: string]: unknown;
}

/** Custom request header a call site sets to declare which repo a request
 *  targets, for the rare Octokit call whose GitHub endpoint carries no
 *  owner/repo in its structured request parameters -- see
 *  `resolveRequestRepo`'s doc comment for the two call sites that need it
 *  today. Always lowercase: `@octokit/endpoint`'s own `merge()` lowercases
 *  every header key before this module's auth hook ever sees the merged
 *  options, so a mixed-case constant here would simply never match. */
export const REPO_HEADER = 'x-agent-lcars-repo';

/**
 * Derives the `owner/name` repo an Octokit request targets, for
 * `createGithubClientAuthStrategy`'s per-request token routing below.
 * `getGithubClient()` is one singleton Octokit instance serving reads and
 * mutations across every watched repo (multiple owners) -- unlike the
 * outbox drain's `DispatchTokenProvider.tokenFor(repo)` call sites, which
 * always know their target repo directly, an Octokit auth hook only sees
 * the request's own merged options and must recover it structurally:
 *
 * 1. REST endpoint methods (`octokit.rest.*`) always pass `owner`/`repo` as
 *    named parameters -- `@octokit/endpoint`'s `merge()` puts them directly
 *    on the merged options object (verified against the installed
 *    `@octokit/endpoint` source: the URL template itself stays unexpanded
 *    at hook time, but the substitution parameters are already present, so
 *    parsing the URL string itself is unnecessary and would be strictly
 *    more fragile).
 * 2. GraphQL requests (`octokit.graphql(query, variables)`) carry no
 *    owner/repo in their URL at all (`POST /graphql` always) -- `variables`
 *    is where a query's own `$owner`/`$name` arguments land, so a query
 *    that declares and passes them (see `item-enrichment.ts`'s
 *    `buildQuery`, called with `{owner: repo.owner, name: repo.name}`) is
 *    still recoverable this way with no call-site change.
 * 3. Neither shape fits `search.issuesAndPullRequests` (the repo lives
 *    inside a `repo:owner/name` qualifier embedded in the free-text `q`
 *    string, not a structured parameter) or a GraphQL mutation keyed by an
 *    opaque node id alone (`backend-actions.ts`'s
 *    `ENABLE_AUTO_MERGE_MUTATION`, keyed by `pullRequestId`). Both call
 *    sites instead set the {@link REPO_HEADER} header explicitly -- the one
 *    deliberate escape hatch, rather than something this function guesses
 *    at (e.g. parsing `q` back apart, or decoding the GraphQL node id, both
 *    far more fragile than the caller just saying so).
 *
 * Returns `undefined` when none of the above resolves. The caller treats
 * that as a hard failure: silently sending a request with the wrong repo's
 * token, or none, is worse than a loud error naming the unresolvable
 * request.
 */
export function resolveRequestRepo(
  options: RequestEndpointOptions,
): string | undefined {
  const headerValue = options.headers?.[REPO_HEADER];
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }
  if (typeof options.owner === 'string' && typeof options.repo === 'string') {
    return `${options.owner}/${options.repo}`;
  }
  const variables = options.variables as Record<string, unknown> | undefined;
  if (
    typeof variables?.['owner'] === 'string' &&
    typeof variables['name'] === 'string'
  ) {
    return `${variables['owner']}/${variables['name']}`;
  }
  return undefined;
}

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 401
  );
}

export interface CreateGithubClientAuthStrategyOptions {
  /** The GitHub App's client ID -- forwarded to `AppInstallationTokenProvider`. */
  clientId: string;
  /** The GitHub App's private key, PEM-encoded -- forwarded to
   *  `AppInstallationTokenProvider`. */
  privateKeyPem: string;
  /** The permission set requested for every token this strategy mints --
   *  forwarded to `AppInstallationTokenProvider`. */
  permissions?: Record<string, string>;
  /** Injectable for tests; forwarded to `AppInstallationTokenProvider`. */
  fetchImpl?: typeof fetch;
  /** Every other field Octokit's constructor merges into the options object
   *  passed to an `authStrategy` function (`request`, `log`, `octokit`,
   *  `octokitOptions`) -- unread here, but present at runtime. */
  [key: string]: unknown;
}

/**
 * The Octokit `authStrategy` `getGithubClient()` wires in (see
 * `github-client.ts`): resolves each request's target repo
 * (`resolveRequestRepo` above), mints/caches a per-repo installation token
 * through an owned `AppInstallationTokenProvider` (constructed once, for
 * the lifetime of the singleton Octokit client -- see `getGithubClient()`),
 * and retries exactly once with a freshly minted token on a 401. A 401
 * means the bearer token itself was rejected before GitHub executed
 * anything -- unlike a 5xx/network error, there is no ambiguity about
 * whether a mutation already landed, so retrying is safe regardless of
 * HTTP method (contrast `github-client.ts`'s `disableRetryForMutations`,
 * which forces mutating requests' *generic* retry budget to zero for
 * exactly that ambiguity, and is unaffected by this: this retry runs
 * inside the auth hook, upstream of plugin-retry entirely).
 *
 * Matches the `authStrategy` contract Octokit's own `@octokit/auth-token`
 * uses (see its installed `hook.js`): called once at construction with
 * `options.auth` merged in, returns `{ hook }`; `hook` is wrapped around
 * every subsequent request/graphql call, and is invoked with the request
 * function plus either an already-merged options object (how Octokit's own
 * request/graphql pipeline actually calls it) or a route string and a
 * separate parameters object -- `request.endpoint.merge(route, parameters)`
 * normalizes both shapes into one, mirroring `@octokit/auth-token` exactly
 * rather than assuming only one calling convention.
 */
export function createGithubClientAuthStrategy(
  strategyOptions: CreateGithubClientAuthStrategyOptions,
): {
  hook: (
    request: ((options: RequestEndpointOptions) => Promise<unknown>) & {
      endpoint: {
        merge: (route: unknown, parameters: unknown) => RequestEndpointOptions;
      };
    },
    route: unknown,
    parameters?: unknown,
  ) => Promise<unknown>;
} {
  // Eagerly parse-validate, same reasoning as `createDispatchTokenProvider`'s
  // own eager call: `AppInstallationTokenProvider.tokenFor` only parses the
  // key lazily, inside `mintAppJwt`, the first time some request actually
  // reaches this hook. Octokit calls `authStrategy` synchronously inside
  // its own constructor, so throwing here surfaces a malformed
  // `AGENT_LCARS_APP_PRIVATE_KEY` at `getGithubClient()`'s very first call
  // post-deploy (in practice, the first page load) rather than only once
  // some request happens to need a fresh mint.
  parsePrivateKey(strategyOptions.privateKeyPem);

  const provider = new AppInstallationTokenProvider({
    clientId: strategyOptions.clientId,
    privateKeyPem: strategyOptions.privateKeyPem,
    fetchImpl: strategyOptions.fetchImpl,
    permissions: strategyOptions.permissions,
  });

  return {
    hook: async (request, route, parameters) => {
      const options = request.endpoint.merge(route, parameters);

      const repo = resolveRequestRepo(options);
      if (repo === undefined) {
        throw new Error(
          `agent-lcars: cannot determine the target repo for ${String(options.method)} ${String(options.url)} - pass an explicit ${REPO_HEADER} header naming it`,
        );
      }

      const headers = { ...options.headers };
      delete headers[REPO_HEADER];

      const token = await provider.tokenFor(repo);
      const authorized: RequestEndpointOptions = {
        ...options,
        headers: { ...headers, authorization: `token ${token}` },
      };
      try {
        return await request(authorized);
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        provider.invalidate(repo);
        const freshToken = await provider.tokenFor(repo);
        return await request({
          ...authorized,
          headers: {
            ...authorized.headers,
            authorization: `token ${freshToken}`,
          },
        });
      }
    },
  };
}
