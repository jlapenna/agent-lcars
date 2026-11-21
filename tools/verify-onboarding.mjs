#!/usr/bin/env node
// Read-only setup audit. Only short-lived read-token mint/revoke uses non-GET.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'yaml';
import { z } from 'zod';

import { createAppJwt } from './configure-github-app-webhook.mjs';

const root = new URL('../', import.meta.url);
const readJson = (name) =>
  JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const readYaml = (name) => parse(readFileSync(new URL(name, root), 'utf8'));
class AuditError extends Error {}
class UnverifiableError extends AuditError {}
class GitHubHttpError extends AuditError {
  constructor(status, rateLimited) {
    super(`GitHub HTTP ${status}`);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}
// GitHub hides permission-limited resources behind both 403 and 404. Neither
// proves a setup mismatch. Rate limits and authentication/server errors do.
const isAccessGap = (error) =>
  error instanceof GitHubHttpError &&
  [403, 404].includes(error.status) &&
  !error.rateLimited;
const failureStatus = (error) =>
  error instanceof UnverifiableError || isAccessGap(error)
    ? 'unverifiable'
    : 'fail';

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

// The receipt transport accepts only the resolved public identity projection.
// Full deployed configurations remain supported by the existing file input.
export function resolvedRegistrationInventory(source) {
  const registration = z.strictObject({
    name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    github: z.strictObject({
      url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+(?:\/[\w.-]+)?$/),
    }),
    app: z.strictObject({
      client_id: z.string().regex(/^(?:Iv[A-Za-z0-9]+|[1-9][0-9]*)$/),
      installation_id: z.number().int().positive().safe(),
    }),
  });
  try {
    const config = z
      .strictObject({
        registrations: z.array(registration).min(1),
      })
      .parse(parse(source));
    if (
      new Set(config.registrations.map(({ name }) => name)).size !==
      config.registrations.length
    )
      throw new Error('Duplicate registration');
    return config;
  } catch {
    // Never print YAML, schema diagnostics, or arbitrary supplied field values.
    throw new AuditError('Invalid resolved registration inventory');
  }
}

export function runnerRegistrations(config) {
  if (config.github !== undefined || config.app !== undefined)
    throw new AuditError(
      'Root runner registration is no longer supported; supply current ARC registrations and their resolved App identities with --registrations=PATH.',
    );
  const registrations = (config.registrations ?? []).filter(
    (item) => !item.disabled,
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
    if (!response.ok)
      throw new GitHubHttpError(
        response.status,
        response.status === 403 &&
          (response.headers?.get?.('x-ratelimit-remaining') === '0' ||
            Boolean(response.headers?.get?.('retry-after'))),
      );
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
  auditReadToken,
}) {
  const facts = [];
  const explicitMetadataToken = auditReadToken?.trim();
  const metadataToken = explicitMetadataToken || token;
  const missingMetadataCredential = (capability) =>
    new UnverifiableError(
      `${capability}: unavailable to the current identity; run the onboarding audit with the existing maintainer credential as AUDIT_READ_TOKEN`,
    );
  async function optionalMetadataRead(capability, action) {
    try {
      return await action();
    } catch (error) {
      if (isAccessGap(error)) throw missingMetadataCredential(capability);
      throw error;
    }
  }
  async function fact(name, action) {
    try {
      facts.push({ repo, fact: name, status: 'pass', detail: await action() });
    } catch (error) {
      facts.push({
        repo,
        fact: name,
        status: failureStatus(error),
        detail: safeMessage(error),
      });
    }
  }
  await fact('fleet-login', async () => {
    if (!token) throw new UnverifiableError('Fleet App credential unavailable');
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
    if (!token) throw new UnverifiableError('Fleet App credential unavailable');
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
    const capability = 'Repository variables';
    if (!metadataToken) throw missingMetadataCredential(capability);
    const profile = Object.entries(profiles).find(([, value]) =>
      value.repositories.includes(repo),
    )?.[0];
    if (!profile)
      throw new AuditError('Repository missing from variable manifest');
    const variables = Object.fromEntries(
      (
        await optionalMetadataRead(capability, () =>
          pages(
            api,
            `/repos/${repo}/actions/variables`,
            metadataToken,
            'variables',
          ),
        )
      ).map(({ name, value }) => [name, value]),
    );
    checkVariables(profile, variables);
    return `required ${profile} variables present`;
  });
  await fact('required-checks', async () => {
    const capability = 'Rules and check metadata';
    if (!metadataToken) throw missingMetadataCredential(capability);
    const metadata = await optionalMetadataRead(capability, () =>
      api(`/repos/${repo}`, metadataToken),
    );
    const branch = encodeURIComponent(metadata.default_branch);
    const rules = await optionalMetadataRead(capability, () =>
      pages(api, `/repos/${repo}/rules/branches/${branch}`, metadataToken),
    );
    const required = rules
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters.required_status_checks);
    if (!required.length)
      throw new AuditError('Default branch has no required checks');
    const commit = await optionalMetadataRead(capability, () =>
      api(`/repos/${repo}/commits/${branch}`, metadataToken),
    );
    const checks = await optionalMetadataRead(capability, () =>
      pages(
        api,
        `/repos/${repo}/commits/${commit.sha}/check-runs?filter=all`,
        metadataToken,
        'check_runs',
      ),
    );
    const statuses = await optionalMetadataRead(capability, () =>
      pages(
        api,
        `/repos/${repo}/commits/${commit.sha}/statuses`,
        metadataToken,
      ),
    );
    // PR-only statuses belong to the reviewed head, even after squash merge.
    const reviewRule = required.find(
      (rule) =>
        rule.context === 'LCARS review' &&
        [15368, 4457090].includes(rule.integration_id),
    );
    const missing = required.filter(
      (rule) =>
        rule !== reviewRule &&
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
        const runs = await optionalMetadataRead(capability, () =>
          api(
            `/repos/${repo}/actions/runs?head_sha=${commit.sha}&per_page=100`,
            metadataToken,
          ),
        );
        if (
          !runs.workflow_runs?.length ||
          runs.workflow_runs.some((run) => run.status !== 'completed')
        ) {
          throw new UnverifiableError(
            `Required contexts not yet observed on ${commit.sha}; rerun after default-branch CI completes`,
          );
        }
      }
      throw new AuditError(
        `Required checks absent on default-branch head: ${missing.map((check) => check.context).join(', ')}`,
      );
    }
    let reviewStatusObserved = false;
    if (reviewRule) {
      const pulls = await optionalMetadataRead(capability, () =>
        pages(api, `/repos/${repo}/commits/${commit.sha}/pulls`, metadataToken),
      );
      const merged = pulls.find(
        (pr) => pr.merge_commit_sha === commit.sha && pr.merged_at,
      );
      if (!merged?.head?.sha) {
        throw new UnverifiableError(
          'Merged PR head unavailable for the required LCARS review',
        );
      }
      if (reviewRule.integration_id === 4457090) {
        const headChecks = await optionalMetadataRead(capability, () =>
          pages(
            api,
            `/repos/${repo}/commits/${merged.head.sha}/check-runs?filter=all`,
            metadataToken,
            'check_runs',
          ),
        );
        reviewStatusObserved = headChecks.some(
          (check) =>
            check.name === reviewRule.context &&
            check.app?.id === reviewRule.integration_id &&
            check.head_sha === merged.head.sha &&
            check.external_id === 'lcars-review',
        );
      } else {
        const headStatuses = await optionalMetadataRead(capability, () =>
          pages(
            api,
            `/repos/${repo}/commits/${merged.head.sha}/statuses`,
            metadataToken,
          ),
        );
        reviewStatusObserved = headStatuses.some(
          (status) =>
            status.context === reviewRule.context &&
            status.creator?.login === 'github-actions[bot]',
        );
      }
      if (!reviewStatusObserved) {
        // Current rules may have been introduced after this PR merged.
        const requiresReview = (rule) =>
          rule.parameters?.required_status_checks?.some(
            (check) =>
              check.context === reviewRule.context &&
              check.integration_id === reviewRule.integration_id,
          );
        const ref = `refs/heads/${metadata.default_branch}`;
        const suitesPath = `/repos/${repo}/rulesets/rule-suites`;
        const suites = await optionalMetadataRead(capability, () =>
          pages(
            api,
            `${suitesPath}?ref=${encodeURIComponent(ref)}&time_period=month&rule_suite_result=all`,
            metadataToken,
          ),
        );
        const suite = suites.find(
          (item) =>
            item.after_sha === commit.sha &&
            item.ref === ref &&
            ['pass', 'bypass'].includes(item.result),
        );
        if (!suite)
          throw new UnverifiableError(
            'No retained rule evaluation for the default-branch update',
          );
        const detail = await optionalMetadataRead(capability, () =>
          api(`${suitesPath}/${suite.id}`, metadataToken),
        );
        // The recorded update establishes which rulesets actually targeted
        // this branch, including when historical ref conditions differed.
        const appliedSources = new Set(
          detail.rule_evaluations
            .filter(
              (evaluation) =>
                evaluation.enforcement === 'active' &&
                evaluation.rule_type === 'required_status_checks' &&
                evaluation.rule_source.type === 'ruleset',
            )
            .map((evaluation) => evaluation.rule_source.id),
        );
        for (const source of rules.filter(requiresReview)) {
          if (
            !appliedSources.has(source.ruleset_id) ||
            source.ruleset_source_type !== 'Repository'
          )
            continue;
          const historyPath = `/repos/${repo}/rulesets/${source.ruleset_id}/history`;
          try {
            const history = await pages(api, historyPath, metadataToken);
            const prior = history
              .filter(
                (item) =>
                  Date.parse(item.updated_at) <= Date.parse(suite.pushed_at),
              )
              .sort(
                (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
              )[0];
            if (!prior) continue;
            const { state } = await api(
              `${historyPath}/${prior.version_id}`,
              metadataToken,
            );
            if (
              state.enforcement === 'active' &&
              state.rules.some(requiresReview)
            ) {
              throw new AuditError(
                'Required LCARS review absent on merged PR head',
              );
            }
          } catch (error) {
            if (!isAccessGap(error)) throw error;
          }
        }
        throw new UnverifiableError(
          'LCARS review requirement at the merged update could not be established; verify after the next reviewed merge',
        );
      }
    }
    return `${required.length} required contexts observed on ${commit.sha}`;
  });
  return facts;
}

export function auditHasFailure(facts) {
  return facts.some((fact) => fact.status === 'fail');
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
          status: 'pass',
          detail: `installation ${installations.get(repo).id}`,
        });
      } catch (error) {
        facts.push({
          repo,
          fact: 'app-installation',
          status: failureStatus(error),
          detail: safeMessage(error),
        });
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
    // ARC registration identities come from Homelab's accepted audit receipt.
    let registrations = [];
    try {
      registrations = runnerRegistrations(registrationConfig ?? {});
      if (!registrations.length)
        throw new UnverifiableError(
          'No active runner registrations in configuration; supply current registration targets and their actual App identities with --registrations=PATH. Runner coverage was not audited.',
        );
    } catch (error) {
      facts.push({
        repo: 'registrations',
        fact: 'configuration',
        status: failureStatus(error),
        detail: safeMessage(error),
      });
    }
    for (const registration of registrations) {
      const fact = {
        repo: registration.target,
        fact: `runner-list:${registration.name}`,
      };
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
          status: 'unverifiable',
          detail:
            'Registration App identity absent or differs from supplied App credential; supply its declared identity with RUNNER_APP_CLIENT_ID/RUNNER_APP_PRIVATE_KEY',
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
          throw new UnverifiableError(
            'Registration App lacks runner-list permission; use its existing authorized identity at onboarding',
          );
        const minted = await api(
          `/app/installations/${installation.id}/access_tokens`,
          registrationJwt,
          'POST',
          { permissions: { [readable]: 'read' } },
        );
        try {
          await api(`${registration.endpoint}?per_page=1`, minted.token);
        } finally {
          try {
            await api('/installation/token', minted.token, 'DELETE');
          } catch {
            throw new AuditError('Could not revoke temporary read token');
          }
        }
        facts.push({
          ...fact,
          status: 'pass',
          detail: 'correctly scoped runner-list request succeeded',
        });
      } catch (error) {
        facts.push({
          ...fact,
          status: failureStatus(error),
          detail: safeMessage(error),
        });
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
          status: 'fail',
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
    auditReadToken: process.env.AUDIT_READ_TOKEN?.trim() || undefined,
    runnerClientId: process.env.RUNNER_APP_CLIENT_ID,
    runnerPrivateKey: process.env.RUNNER_APP_PRIVATE_KEY,
    registrationConfig: configPath
      ? parse(readFileSync(configPath, 'utf8'))
      : undefined,
  });
  for (const fact of facts) console.log(JSON.stringify(fact));
  if (auditHasFailure(facts)) process.exitCode = 1;
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
