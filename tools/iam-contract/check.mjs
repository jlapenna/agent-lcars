#!/usr/bin/env node
// Assert that live fleet identity state matches the checked-in model in
// model.json. This exists because docs/fleet-credentials.md and homelab's
// autoscaler README are prose: nothing verified them, and the #1368 outage
// was spent testing IAM hypotheses one CI run at a time
// (jlapenna/agent-lcars#1376).
//
// Every finding names the resource and prints expected-vs-actual, so the
// next incident starts with an answer rather than a hypothesis.
//
// Usage:
//   node tools/iam-contract/check.mjs [--sections apps,workflow-refs,wif,keys,secrets]
//   node tools/iam-contract/check.mjs --dump [--sections ...]   # print live state
//
// Credentials, per section:
//   apps           GitHub App private key + client id (AGENT_LCARS_PRIVATE_KEY /
//                  AGENT_LCARS_CLIENT_ID, or --app-private-key-file).
//   workflow-refs  any GitHub read token (app key, GH_TOKEN, or `gh auth token`).
//   wif/keys/secrets  gcloud credentials that can read both projects.

import { execFile } from 'node:child_process';
import { createSign, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const ALL_SECTIONS = ['apps', 'workflow-refs', 'wif', 'keys', 'secrets'];

function parseArgs(argv) {
  const options = {
    sections: ALL_SECTIONS,
    dump: false,
    appPrivateKeyFile: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dump') {
      options.dump = true;
    } else if (arg === '--sections') {
      options.sections = argv[++index]
        .split(',')
        .map((section) => section.trim());
    } else if (arg.startsWith('--sections=')) {
      options.sections = arg
        .slice('--sections='.length)
        .split(',')
        .map((s) => s.trim());
    } else if (arg === '--app-private-key-file') {
      options.appPrivateKeyFile = argv[++index];
    } else if (arg.startsWith('--app-private-key-file=')) {
      options.appPrivateKeyFile = arg.slice('--app-private-key-file='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const section of options.sections) {
    if (!ALL_SECTIONS.includes(section)) {
      throw new Error(
        `unknown section: ${section} (known: ${ALL_SECTIONS.join(', ')})`,
      );
    }
  }
  return options;
}

// ---------------------------------------------------------------- findings

const findings = [];

/**
 * Record one drift. `resource` must be specific enough to act on without
 * re-deriving anything - it is the first thing an incident responder reads.
 */
function fail(resource, expected, actual, hint) {
  findings.push({ resource, expected, actual, hint });
}

function stringify(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function compareExact(resource, expected, actual, hint) {
  const expectedText = stringify(expected);
  const actualText = stringify(actual);
  if (expectedText !== actualText)
    fail(resource, expectedText, actualText, hint);
}

function compareSets(resource, expected, actual, hint) {
  const expectedSorted = [...new Set(expected)].sort();
  const actualSorted = [...new Set(actual)].sort();
  if (expectedSorted.join('\n') === actualSorted.join('\n')) return;
  const missing = expectedSorted.filter((item) => !actualSorted.includes(item));
  const unexpected = actualSorted.filter(
    (item) => !expectedSorted.includes(item),
  );
  const detail = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  fail(
    resource,
    expectedSorted.join(', '),
    `${actualSorted.join(', ')} (${detail})`,
    hint,
  );
}

// ------------------------------------------------------------------ gcloud

async function gcloudJson(args) {
  const { stdout } = await execFileAsync('gcloud', [...args, '--format=json'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout || 'null');
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// ------------------------------------------------------------------ GitHub

const GITHUB_API = 'https://api.github.com';

async function githubJson(
  pathname,
  token,
  { accept = 'application/vnd.github+json' } = {},
) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-lcars-iam-contract',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(
      `GET ${pathname} -> ${response.status}: ${body.slice(0, 300)}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Mint an App-level JWT (not an installation token): required by /app and /app/installations. */
function mintAppJwt(clientId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: clientId,
      jti: randomUUID(),
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function mintInstallationToken(appJwt, installationId) {
  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'agent-lcars-iam-contract',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens -> ${response.status}: ${(
        await response.text()
      ).slice(0, 300)}`,
    );
  }
  return (await response.json()).token;
}

async function resolveAppPrivateKey(options) {
  if (options.appPrivateKeyFile) {
    return (await readFile(options.appPrivateKeyFile, 'utf8')).trim();
  }
  if (process.env.AGENT_LCARS_PRIVATE_KEY)
    return process.env.AGENT_LCARS_PRIVATE_KEY.trim();
  return '';
}

async function resolveReadToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const { stdout } = await execFileAsync('gh', ['auth', 'token']);
  return stdout.trim();
}

// ----------------------------------------------------------------- section: apps

async function readAppState(app, appJwt) {
  const metadata = await githubJson('/app', appJwt);
  const installations = await githubJson(
    '/app/installations?per_page=100',
    appJwt,
  );
  const perInstallation = await mapWithConcurrency(
    installations,
    4,
    async (installation) => {
      const token = await mintInstallationToken(appJwt, installation.id);
      const listed = await githubJson(
        '/installation/repositories?per_page=100',
        token,
      );
      return {
        id: installation.id,
        account: installation.account?.login,
        repositorySelection: installation.repository_selection,
        repositories: listed.repositories
          .map((repository) => repository.full_name)
          .sort(),
      };
    },
  );
  return {
    key: app.key,
    slug: metadata.slug,
    clientId: metadata.client_id,
    owner: { login: metadata.owner?.login, type: metadata.owner?.type },
    installations: perInstallation.sort((a, b) => a.id - b.id),
  };
}

function assertApp(expected, live) {
  const label = `github-app ${expected.slug}`;
  compareExact(`${label} slug`, expected.slug, live.slug);
  compareExact(`${label} client id`, expected.clientId, live.clientId);
  compareExact(
    `${label} owner`,
    expected.owner,
    live.owner,
    'both Apps are owned by the agent-lcars USER account, not an org',
  );
  compareSets(
    `${label} installation ids`,
    expected.installations.map((installation) => String(installation.id)),
    live.installations.map((installation) => String(installation.id)),
  );
  for (const expectedInstallation of expected.installations) {
    const liveInstallation = live.installations.find(
      (item) => item.id === expectedInstallation.id,
    );
    if (!liveInstallation) continue;
    const installationLabel = `${label} installation ${expectedInstallation.id} (${expectedInstallation.account})`;
    compareExact(
      `${installationLabel} account`,
      expectedInstallation.account,
      liveInstallation.account,
    );
    compareExact(
      `${installationLabel} repository_selection`,
      expectedInstallation.repositorySelection,
      liveInstallation.repositorySelection,
    );
    compareSets(
      `${installationLabel} repositories`,
      expectedInstallation.repositories,
      liveInstallation.repositories,
      'add or remove repositories in the GitHub App installation UI, then update tools/iam-contract/model.json',
    );
  }
}

/**
 * Every fleet repository must be covered by an installation of a checkable App,
 * unless the model lists it as an exception with a reason. This is what catches
 * "the repo was added to the WIF pool and to Terraform, but nobody added it to
 * the App installation" - the two are edited in completely different places.
 */
function assertFleetCoverage(model, liveApps) {
  const covered = new Set();
  for (const app of liveApps) {
    for (const installation of app.installations) {
      for (const repository of installation.repositories)
        covered.add(repository);
    }
  }
  const exceptions = new Map(
    (model.fleetCoverageExceptions ?? []).map((entry) => [
      entry.repository,
      entry.reason,
    ]),
  );
  for (const repository of model.fleetRepositories) {
    if (covered.has(repository)) {
      if (exceptions.has(repository)) {
        fail(
          `fleet coverage exception ${repository}`,
          'the exception is still needed (the repo is not covered by a fleet App installation)',
          'the repository IS covered now - the exception is stale',
          'remove the entry from fleetCoverageExceptions in tools/iam-contract/model.json',
        );
      }
      continue;
    }
    if (exceptions.has(repository)) {
      console.log(
        `[known gap] fleet repository ${repository} is not installed: ${exceptions.get(repository)}`,
      );
      continue;
    }
    fail(
      `fleet coverage ${repository}`,
      'covered by an installation of the fleet GitHub App',
      'not present in any installation repository list',
      'add the repository to the right App installation in the GitHub UI (the REST endpoint for this only accepts a GitHub-App user token, so gh cannot do it)',
    );
  }
}

// ----------------------------------------------------------------- section: wif

async function readWifState(projectId, model) {
  const pools = await gcloudJson([
    'iam',
    'workload-identity-pools',
    'list',
    `--project=${projectId}`,
    '--location=global',
  ]);
  const state = {};
  for (const pool of pools ?? []) {
    const poolId = pool.name.split('/').pop();
    const entry = { state: pool.state, providers: {} };
    // Managed pools such as <project>.svc.id.goog reject ListProviders
    // outright; the model marks them and we record no providers.
    if (model?.pools?.[poolId]?.providersListable === false) {
      entry.providers = null;
    } else {
      const providers = await gcloudJson([
        'iam',
        'workload-identity-pools',
        'providers',
        'list',
        `--project=${projectId}`,
        '--location=global',
        `--workload-identity-pool=${poolId}`,
      ]);
      for (const provider of providers ?? []) {
        entry.providers[provider.name.split('/').pop()] = {
          state: provider.state,
          issuerUri: provider.oidc?.issuerUri ?? null,
          attributeMapping: provider.attributeMapping ?? null,
          attributeCondition: provider.attributeCondition ?? null,
        };
      }
    }
    state[poolId] = entry;
  }
  return state;
}

function assertWif(projectId, expectedProject, livePools) {
  const expectedPools = expectedProject.pools;
  compareSets(
    `wif pools in project ${projectId}`,
    Object.keys(expectedPools),
    Object.keys(livePools),
    'a pool nobody documented is a standing trust relationship nobody reviews',
  );
  for (const [poolId, expectedPool] of Object.entries(expectedPools)) {
    const livePool = livePools[poolId];
    if (!livePool) continue;
    const poolLabel = `wif pool ${projectId}/${poolId}`;
    compareExact(`${poolLabel} state`, expectedPool.state, livePool.state);
    if (expectedPool.providersListable === false) continue;
    compareSets(
      `${poolLabel} providers`,
      Object.keys(expectedPool.providers ?? {}),
      Object.keys(livePool.providers ?? {}),
    );
    for (const [providerId, expectedProvider] of Object.entries(
      expectedPool.providers ?? {},
    )) {
      const liveProvider = livePool.providers?.[providerId];
      if (!liveProvider) continue;
      const providerLabel = `wif provider ${projectId}/${poolId}/${providerId}`;
      compareExact(
        `${providerLabel} state`,
        expectedProvider.state,
        liveProvider.state,
      );
      compareExact(
        `${providerLabel} issuerUri`,
        expectedProvider.issuerUri,
        liveProvider.issuerUri,
      );
      compareExact(
        `${providerLabel} attributeMapping`,
        expectedProvider.attributeMapping,
        liveProvider.attributeMapping,
      );
      compareExact(
        `${providerLabel} attributeCondition`,
        expectedProvider.attributeCondition,
        liveProvider.attributeCondition,
        'gcloud ... update-oidc --attribute-condition REPLACES the condition; change it in Terraform (this repo for project agent-lcars, jlapenna/homelab for project supersprinklesracing) and apply',
      );
    }
  }
}

// -------------------------------------------------------- section: workflow-refs

const WORKFLOW_REF_PATTERN =
  /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)/g;

function collectModelledWorkflowRefs(model) {
  const refs = new Map();
  for (const [projectId, project] of Object.entries(model.gcpProjects)) {
    for (const [poolId, pool] of Object.entries(project.pools)) {
      for (const [providerId, provider] of Object.entries(
        pool.providers ?? {},
      )) {
        const condition = provider.attributeCondition ?? '';
        for (const match of condition.matchAll(WORKFLOW_REF_PATTERN)) {
          const [, owner, repository, workflow] = match;
          const key = `${owner}/${repository}/.github/workflows/${workflow}`;
          if (!refs.has(key)) refs.set(key, []);
          refs.get(key).push(`${projectId}/${poolId}/${providerId}`);
        }
      }
    }
  }
  return refs;
}

async function assertWorkflowRefs(model, tokenForOwner) {
  const refs = collectModelledWorkflowRefs(model);
  await mapWithConcurrency([...refs.entries()], 4, async ([ref, trustedBy]) => {
    const [owner, repository, , , workflow] = ref.split('/');
    const token = await tokenForOwner(owner);
    try {
      await githubJson(
        `/repos/${owner}/${repository}/contents/.github/workflows/${workflow}`,
        token,
      );
    } catch (error) {
      if (error.status === 404) {
        fail(
          `wif trusted workflow ref ${ref}`,
          'the workflow file exists on the repository default branch',
          'HTTP 404 - no such workflow file',
          `trusted by ${trustedBy.join(', ')}; a dead clause is standing trust for a workflow that can be re-created by anyone who can push it`,
        );
        return;
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------- section: keys

async function readUserManagedKeys(projectId) {
  const accounts = await gcloudJson([
    'iam',
    'service-accounts',
    'list',
    `--project=${projectId}`,
  ]);
  const emails = (accounts ?? []).map((account) => account.email).sort();
  const entries = await mapWithConcurrency(emails, 6, async (email) => {
    const keys = await gcloudJson([
      'iam',
      'service-accounts',
      'keys',
      'list',
      `--iam-account=${email}`,
      `--project=${projectId}`,
      '--managed-by=user',
    ]);
    return [email, (keys ?? []).map((key) => key.name.split('/').pop()).sort()];
  });
  return Object.fromEntries(entries);
}

function assertKeys(projectId, expectedProject, liveKeys) {
  const allowlist = expectedProject.userManagedKeyAllowlist ?? [];
  const allowedEmails = allowlist.map((entry) => entry.serviceAccount);
  const withKeys = Object.entries(liveKeys)
    .filter(([, keys]) => keys.length > 0)
    .map(([email]) => email);

  for (const email of withKeys) {
    if (allowedEmails.includes(email)) continue;
    fail(
      `service account key ${projectId}/${email}`,
      'no user-managed key (fleet identities authenticate over Workload Identity Federation)',
      `user-managed key(s): ${liveKeys[email].join(', ')}`,
      'delete the key, or - if it is genuinely required - add it to userManagedKeyAllowlist in tools/iam-contract/model.json with a reason',
    );
  }
  // The allowlist is a ratchet, not a permanent exemption: once a key is
  // retired its entry must go, or the next new key silently inherits the
  // exemption.
  for (const entry of allowlist) {
    if (!(entry.serviceAccount in liveKeys)) {
      fail(
        `user-managed key allowlist ${projectId}/${entry.serviceAccount}`,
        'the allowlisted service account exists',
        'no such service account in the project',
        'remove the stale entry from tools/iam-contract/model.json',
      );
      continue;
    }
    if (liveKeys[entry.serviceAccount].length === 0) {
      fail(
        `user-managed key allowlist ${projectId}/${entry.serviceAccount}`,
        'still holds a user-managed key (that is why it is allowlisted)',
        'no user-managed keys remain - the exemption is stale',
        'retirement completed: remove this entry from tools/iam-contract/model.json so the exemption cannot be inherited',
      );
    }
  }
}

// ------------------------------------------------------------- section: secrets

async function readSecretPolicy(projectId, secret) {
  const policy = await gcloudJson([
    'secrets',
    'get-iam-policy',
    secret,
    `--project=${projectId}`,
  ]);
  const bindings = {};
  for (const binding of policy?.bindings ?? []) {
    bindings[binding.role] = [...(binding.members ?? [])].sort();
  }
  return bindings;
}

function assertSecretPolicy(expectedEntry, liveBindings) {
  const label = `secret iam ${expectedEntry.project}/${expectedEntry.secret}`;
  const hint =
    expectedEntry.rationale ??
    'an extra binding here is a speculative incident-time grant that outlived the incident';
  compareSets(
    `${label} roles`,
    Object.keys(expectedEntry.bindings),
    Object.keys(liveBindings),
    hint,
  );
  // Per-role member sets, so the message names the offending principal rather
  // than printing two policy blobs for a human to diff by eye.
  for (const role of new Set([
    ...Object.keys(expectedEntry.bindings),
    ...Object.keys(liveBindings),
  ])) {
    compareSets(
      `${label} members of ${role}`,
      expectedEntry.bindings[role] ?? [],
      liveBindings[role] ?? [],
      hint,
    );
  }
}

// ------------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = JSON.parse(
    await readFile(path.join(HERE, 'model.json'), 'utf8'),
  );
  const wants = (section) => options.sections.includes(section);
  const dump = {};

  const needsGitHub = wants('apps') || wants('workflow-refs');
  let appJwt = '';
  const installationTokens = new Map();
  let readToken = '';

  if (needsGitHub) {
    const appPrivateKey = await resolveAppPrivateKey(options);
    if (appPrivateKey) {
      const clientId =
        process.env.AGENT_LCARS_CLIENT_ID || model.githubApps[0].clientId;
      appJwt = mintAppJwt(clientId, appPrivateKey);
    } else if (wants('apps')) {
      throw new Error(
        'section "apps" needs the fleet App private key: set AGENT_LCARS_PRIVATE_KEY or pass --app-private-key-file (GET /app/installations only accepts an App JWT)',
      );
    }
    if (!appJwt) readToken = await resolveReadToken();
  }

  const tokenForOwner = async (owner) => {
    if (!appJwt) return readToken;
    if (installationTokens.has(owner)) return installationTokens.get(owner);
    const app = model.githubApps.find((candidate) => candidate.checkable);
    const installation = app.installations.find(
      (entry) => entry.account === owner,
    );
    if (!installation) {
      throw new Error(
        `no modelled installation of ${app.slug} for owner ${owner}`,
      );
    }
    const token = await mintInstallationToken(appJwt, installation.id);
    installationTokens.set(owner, token);
    return token;
  };

  if (wants('apps')) {
    const liveApps = [];
    for (const app of model.githubApps) {
      if (!app.checkable) {
        console.log(
          `[known gap] github-app ${app.slug}: not asserted from this runner - ${app.uncheckableReason}`,
        );
        continue;
      }
      const live = await readAppState(app, appJwt);
      liveApps.push(live);
      dump[`app:${app.slug}`] = live;
      if (!options.dump) assertApp(app, live);
    }
    if (!options.dump) assertFleetCoverage(model, liveApps);
  }

  if (wants('wif')) {
    for (const [projectId, project] of Object.entries(model.gcpProjects)) {
      const live = await readWifState(projectId, project);
      dump[`wif:${projectId}`] = live;
      if (!options.dump) assertWif(projectId, project, live);
    }
  }

  if (wants('workflow-refs')) {
    if (options.dump) {
      dump['workflow-refs'] = Object.fromEntries(
        collectModelledWorkflowRefs(model),
      );
    } else {
      await assertWorkflowRefs(model, tokenForOwner);
    }
  }

  if (wants('keys')) {
    for (const [projectId, project] of Object.entries(model.gcpProjects)) {
      const live = await readUserManagedKeys(projectId);
      dump[`keys:${projectId}`] = Object.fromEntries(
        Object.entries(live).filter(([, keys]) => keys.length > 0),
      );
      if (!options.dump) assertKeys(projectId, project, live);
    }
  }

  if (wants('secrets')) {
    for (const entry of model.secretIamPolicies) {
      const live = await readSecretPolicy(entry.project, entry.secret);
      dump[`secret:${entry.project}/${entry.secret}`] = live;
      if (!options.dump) assertSecretPolicy(entry, live);
    }
  }

  if (options.dump) {
    console.log(JSON.stringify(dump, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log(
      `IAM contract OK: sections [${options.sections.join(', ')}] match tools/iam-contract/model.json`,
    );
    return;
  }

  console.error(`\nIAM contract drift: ${findings.length} finding(s)\n`);
  for (const finding of findings) {
    console.error(`✗ ${finding.resource}`);
    console.error(`  expected: ${finding.expected}`);
    console.error(`  actual:   ${finding.actual}`);
    if (finding.hint) console.error(`  fix:      ${finding.hint}`);
    console.error('');
  }
  console.error(
    'Either the world drifted (fix the world) or the model is out of date (fix tools/iam-contract/model.json and docs/fleet-credentials.md together).',
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`iam-contract check failed to run: ${error.message}`);
  process.exitCode = 2;
});
