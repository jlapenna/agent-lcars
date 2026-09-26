#!/usr/bin/env node
// Read-only setup audit. Only short-lived read-token mint/revoke uses non-GET.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'yaml';

import { createAppJwt } from './configure-github-app-webhook.mjs';

const root = new URL('../', import.meta.url);
const readJson = (name) =>
  JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const readYaml = (name) => parse(readFileSync(new URL(name, root), 'utf8'));
class AuditError extends Error {}
class UnverifiedError extends AuditError {}
const safeMessage = (error) =>
  error instanceof AuditError || /^GitHub HTTP \d+$/.test(error.message)
    ? error.message
    : 'Audit request failed';

const repoPattern = /^[\w.-]+\/[\w.-]+$/;

export function watchedRepositories(config) {
  const value = config.env.find(
    (item) => item.variable === 'AGENT_LCARS_WATCHED_REPOS',
  )?.value;
  const repos = JSON.parse(value)
    .filter((repo) => repo.agents !== false)
    .map(({ owner, name }) => `${owner}/${name}`);
  if (!repos.length || repos.some((repo) => !repoPattern.test(repo)))
    throw new AuditError('Invalid watched-repository configuration');
  return [...new Set(repos)];
}

export function runnerRegistrations(config, legacyApp) {
  const registrations = [];
  if (config.github?.url)
    registrations.push({
      name: 'default',
      github: config.github,
      app: config.app ?? legacyApp,
    });
  registrations.push(
    ...(config.registrations ?? []).filter((item) => !item.disabled),
  );
  return registrations.map(({ name, github, app }) => {
    const url = new URL(github.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      url.origin !== 'https://github.com' ||
      parts.length < 1 ||
      parts.length > 2 ||
      parts.some((part) => !/^[\w.-]+$/.test(part))
    )
      throw new AuditError('Invalid runner registration URL');
    return {
      name,
      target: parts.join('/'),
      clientId: app?.client_id,
      installationId: app?.installation_id,
      endpoint:
        parts.length === 2
          ? `/repos/${parts.join('/')}/actions/runners`
          : `/orgs/${parts[0]}/actions/runners`,
    };
  });
}

export function createApi(fetchImpl = fetch) {
  return async (path, token, method = 'GET', body) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    // Never include response bodies, tokens, variables, or fetch exception text.
    if (!response.ok) throw new AuditError(`GitHub HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

async function pages(api, path, token, key) {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = await api(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      token,
    );
    const batch = key ? result[key] : result;
    if (!Array.isArray(batch))
      throw new AuditError('Unexpected GitHub list response');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

export function assertVariables(profile, variables) {
  const actionPath = fileURLToPath(
    new URL('.github/actions/assert-repo-vars/', root),
  );
  const manifest = readJson('config/github-variables.json').profiles[profile];
  const required = Object.entries(manifest.variables)
    .filter(([, rule]) => rule.required)
    .map(([name]) => name);
  // The shared action reports names only; values remain in child environment.
  const values = required
    .map((name) => `${name}=${variables[name]?.trim() ? 'present' : ''}`)
    .join('\n');
  try {
    execFileSync('bash', [`${actionPath}/assert.sh`], {
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionPath,
        PROFILE: profile,
        VARS: values || '\n',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new AuditError(
      `Missing required variables: ${required.filter((name) => !variables[name]?.trim()).join(', ')}`,
    );
  }
}

export async function auditRepository({
  repo,
  token,
  api,
  labels,
  profiles,
  fleetLogin,
  checkVariables = assertVariables,
  auditReadToken = token,
}) {
  const facts = [];
  async function fact(name, action) {
    try {
      facts.push({ repo, fact: name, status: 'PASS', detail: await action() });
    } catch (error) {
      facts.push({
        repo,
        fact: name,
        status: error instanceof UnverifiedError ? 'UNVERIFIED' : 'FAIL',
        detail: safeMessage(error),
      });
    }
  }
  await fact('fleet-login', async () => {
    const permission = await api(
      `/repos/${repo}/collaborators/${fleetLogin}/permission`,
      token,
    );
    if (
      !['write', 'admin', 'maintain'].includes(permission.permission) &&
      !permission.user?.permissions?.push
    )
      throw new AuditError('Fleet login lacks push permission');
    await api(`/repos/${repo}/assignees/${fleetLogin}`, token);
    return 'push permission and assignability verified';
  });
  await fact('labels', async () => {
    const expected = labels.repositories[repo]?.labels;
    if (!expected)
      throw new AuditError('Repository missing from label manifest');
    const live = new Map(
      (await pages(api, `/repos/${repo}/labels`, token)).map((label) => [
        label.name,
        label,
      ]),
    );
    const missing = expected.filter((name) => !live.has(name));
    const drift = expected.filter(
      (name) =>
        live.has(name) &&
        (live.get(name).color.toLowerCase() !==
          labels.labels[name].color.toLowerCase() ||
          (live.get(name).description ?? '') !==
            labels.labels[name].description),
    );
    if (missing.length || drift.length)
      throw new AuditError(
        `Missing: ${missing.join(', ') || 'none'}; metadata drift: ${drift.join(', ') || 'none'}`,
      );
    return `${expected.length} declared labels match`;
  });
  await fact('variables', async () => {
    const profile = Object.entries(profiles).find(([, value]) =>
      value.repositories.includes(repo),
    )?.[0];
    if (!profile)
      throw new AuditError('Repository missing from variable manifest');
    const variables = Object.fromEntries(
      (
        await pages(
          api,
          `/repos/${repo}/actions/variables`,
          auditReadToken,
          'variables',
        )
      ).map(({ name, value }) => [name, value]),
    );
    checkVariables(profile, variables);
    return `required ${profile} variables present`;
  });
  await fact('required-checks', async () => {
    const metadata = await api(`/repos/${repo}`, auditReadToken);
    const branch = encodeURIComponent(metadata.default_branch);
    const rules = await pages(
      api,
      `/repos/${repo}/rules/branches/${branch}`,
      auditReadToken,
    );
    const required = rules
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters.required_status_checks);
    if (!required.length)
      throw new AuditError('Default branch has no required checks');
    const commit = await api(
      `/repos/${repo}/commits/${branch}`,
      auditReadToken,
    );
    const checks = await pages(
      api,
      `/repos/${repo}/commits/${commit.sha}/check-runs?filter=all`,
      auditReadToken,
      'check_runs',
    );
    const statuses = await pages(
      api,
      `/repos/${repo}/commits/${commit.sha}/statuses`,
      auditReadToken,
    );
    const missing = required.filter(
      (rule) =>
        !checks.some(
          (check) =>
            check.name === rule.context &&
            (!rule.integration_id || check.app?.id === rule.integration_id),
        ) &&
        !statuses.some(
          (status) => status.context === rule.context && !rule.integration_id,
        ),
    );
    if (missing.length) {
      // A same-named check from the wrong App is a real mismatch. Otherwise
      // let a newly merged head finish emitting its configured contexts.
      if (
        missing.some(
          (rule) => !checks.some((check) => check.name === rule.context),
        )
      ) {
        const runs = await api(
          `/repos/${repo}/actions/runs?head_sha=${commit.sha}&per_page=100`,
          auditReadToken,
        );
        if (
          !runs.workflow_runs?.length ||
          runs.workflow_runs.some((run) => run.status !== 'completed')
        ) {
          throw new UnverifiedError(
            `Required contexts not yet observed on ${commit.sha}; rerun after default-branch CI completes`,
          );
        }
      }
      throw new AuditError(
        `Required checks absent on default-branch head: ${missing.map((check) => check.context).join(', ')}`,
      );
    }
    return `${required.length} required contexts observed on ${commit.sha}`;
  });
  return facts;
}

export async function runAudit({
  clientId,
  privateKey,
  repos,
  labels,
  profiles,
  fleetLogin,
  registrationConfig,
  auditReadToken,
  runnerClientId,
  runnerPrivateKey,
  legacyRunnerApp,
  api = createApi(),
}) {
  const facts = [];
  const jwt = createAppJwt(clientId, privateKey);
  const runnerJwt =
    runnerClientId && runnerPrivateKey
      ? createAppJwt(runnerClientId, runnerPrivateKey)
      : undefined;
  const tokens = new Map();
  const installations = new Map();
  async function tokenFor(repo) {
    const installation = await api(`/repos/${repo}/installation`, jwt);
    if (installation.suspended_at)
      throw new AuditError('Installation suspended');
    installations.set(repo, installation);
    if (!tokens.has(installation.id)) {
      const readable = [
        'metadata',
        'contents',
        'issues',
        'checks',
        'statuses',
        'administration',
        'actions',
        'variables',
        'organization_self_hosted_runners',
      ];
      const permissions = {
        metadata: 'read',
        ...Object.fromEntries(
          readable
            .filter((name) => installation.permissions[name])
            .map((name) => [name, 'read']),
        ),
      };
      const minted = await api(
        `/app/installations/${installation.id}/access_tokens`,
        jwt,
        'POST',
        { permissions },
      );
      tokens.set(installation.id, minted.token);
    }
    return tokens.get(installation.id);
  }
  try {
    for (const repo of repos) {
      let token;
      try {
        token = await tokenFor(repo);
        const visible = await pages(
          api,
          '/installation/repositories',
          token,
          'repositories',
        );
        if (
          !visible.some(
            (item) => item.full_name.toLowerCase() === repo.toLowerCase(),
          )
        )
          throw new AuditError('Repository not visible to installation');
        facts.push({
          repo,
          fact: 'app-installation',
          status: 'PASS',
          detail: `installation ${installations.get(repo).id}`,
        });
      } catch (error) {
        facts.push({
          repo,
          fact: 'app-installation',
          status: 'FAIL',
          detail: safeMessage(error),
        });
        for (const fact of [
          'fleet-login',
          'labels',
          'variables',
          'required-checks',
        ])
          facts.push({
            repo,
            fact,
            status: 'UNVERIFIED',
            detail: 'App installation credential unavailable',
          });
        continue;
      }
      facts.push(
        ...(await auditRepository({
          repo,
          token,
          api,
          labels,
          profiles,
          fleetLogin,
          auditReadToken,
        })),
      );
    }
    // The deployed configuration remains Homelab-owned. Read its data; never
    // import code or copy its registration list into this repository.
    if (!registrationConfig) {
      try {
        const token = await tokenFor('jlapenna/homelab');
        const file = await api(
          '/repos/jlapenna/homelab/contents/github-runner-autoscaler/orchestrator.yml',
          token,
        );
        registrationConfig = parse(
          Buffer.from(file.content, 'base64').toString('utf8'),
        );
      } catch (error) {
        facts.push({
          repo: 'registrations',
          fact: 'configuration',
          status: 'FAIL',
          detail: safeMessage(error),
        });
      }
    }
    if (registrationConfig) {
      for (const registration of runnerRegistrations(
        registrationConfig,
        legacyRunnerApp,
      )) {
        const fact = {
          repo: registration.target,
          fact: `runner-list:${registration.name}`,
        };
        // Legacy root registration receives identity through deployment env.
        // Do not substitute another App and claim its scope was verified.
        const registrationJwt =
          registration.clientId === clientId
            ? jwt
            : registration.clientId === runnerClientId
              ? runnerJwt
              : undefined;
        if (!registrationJwt) {
          facts.push({
            ...fact,
            status: 'UNVERIFIED',
            detail:
              'Registration App identity absent or differs from supplied App credential; audit with its declared identity',
          });
          continue;
        }
        try {
          const lookup = registration.target.includes('/')
            ? `/repos/${registration.target}/installation`
            : `/orgs/${registration.target}/installation`;
          const installation = await api(lookup, registrationJwt);
          if (installation.id !== registration.installationId)
            throw new AuditError(
              'Registration installation differs from authenticated App',
            );
          const readable = registration.target.includes('/')
            ? 'administration'
            : 'organization_self_hosted_runners';
          if (!installation.permissions[readable])
            throw new AuditError(
              'Registration App lacks runner-list permission',
            );
          const minted = await api(
            `/app/installations/${installation.id}/access_tokens`,
            registrationJwt,
            'POST',
            { permissions: { [readable]: 'read' } },
          );
          try {
            await api(`${registration.endpoint}?per_page=1`, minted.token);
            facts.push({
              ...fact,
              status: 'PASS',
              detail: 'correctly scoped runner-list request succeeded',
            });
          } finally {
            await api('/installation/token', minted.token, 'DELETE');
          }
        } catch (error) {
          facts.push({ ...fact, status: 'FAIL', detail: safeMessage(error) });
        }
      }
    }
  } finally {
    for (const token of tokens.values()) {
      try {
        await api('/installation/token', token, 'DELETE');
      } catch {
        facts.push({
          repo: 'credentials',
          fact: 'token-revocation',
          status: 'FAIL',
          detail: 'Could not revoke temporary read token',
        });
      }
    }
  }
  return facts;
}

async function main() {
  const clientId = process.env.APP_CLIENT_ID;
  const privateKey = process.env.APP_PRIVATE_KEY;
  if (!clientId || !privateKey)
    throw new AuditError('APP_CLIENT_ID and APP_PRIVATE_KEY are required');
  const args = process.argv.slice(2);
  const requested = args.find((arg) => arg.startsWith('--repo='))?.slice(7);
  if (
    args.some(
      (arg) =>
        !arg.startsWith('--repo=') && !arg.startsWith('--registrations='),
    )
  )
    throw new AuditError(
      'Only --repo=OWNER/REPO and --registrations=PATH are supported; no repair mode',
    );
  const watched = watchedRepositories(readYaml('apps/console/apphosting.yaml'));
  if (requested && !watched.includes(requested))
    throw new AuditError('Requested repository is not watched');
  const configPath = args
    .find((arg) => arg.startsWith('--registrations='))
    ?.slice(16);
  const facts = await runAudit({
    clientId,
    privateKey,
    repos: requested ? [requested] : watched,
    labels: readJson('config/github-labels.json'),
    profiles: readJson('config/github-variables.json').profiles,
    fleetLogin: process.env.AGENT_FLEET_LOGIN || 'agent-lcars-bot',
    auditReadToken: process.env.AUDIT_READ_TOKEN,
    runnerClientId: process.env.RUNNER_APP_CLIENT_ID,
    runnerPrivateKey: process.env.RUNNER_APP_PRIVATE_KEY,
    legacyRunnerApp:
      process.env.LEGACY_RUNNER_APP_CLIENT_ID &&
      process.env.LEGACY_RUNNER_APP_INSTALLATION_ID
        ? {
            client_id: process.env.LEGACY_RUNNER_APP_CLIENT_ID,
            installation_id: Number(
              process.env.LEGACY_RUNNER_APP_INSTALLATION_ID,
            ),
          }
        : undefined,
    registrationConfig: configPath
      ? parse(readFileSync(configPath, 'utf8'))
      : undefined,
  });
  for (const fact of facts) console.log(JSON.stringify(fact));
  if (facts.some((fact) => fact.status !== 'PASS')) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      'Onboarding audit could not complete; check configuration and App credential availability.',
    );
    process.exitCode = 1;
  });
}
