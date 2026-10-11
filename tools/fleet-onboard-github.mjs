#!/usr/bin/env node
// GitHub-side fleet onboarding for one target repository: the repository
// variables and secret the lanes read, the two App-installation membership
// checks, and the label sync. docs/onboarding-repo.md owns the runbook and
// docs/fleet-credentials.md owns the credential lineage; this tool performs
// the steps they describe without ever printing a value.
//
// Secrecy rules (tested in tools/contract-tests/fleet-onboard-github.test.ts):
// - Values come only from environment variables or `gh variable get` on a
//   named, already-onboarded source repository (--copy-from). There is no CLI
//   flag that accepts a value.
// - The private key is never copied from a repository (GitHub cannot read a
//   secret back). It comes from APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY or a
//   --private-key-command, and reaches `gh secret set` through stdin only.
// - Output is JSON lines of {repo, fact, status, detail}; details carry names,
//   counts, installation ids, and instructions, never values, tokens, or raw
//   GitHub error bodies.
// - --verify never writes. --dry-run never writes and reports PLAN for every
//   write it would make. Writes compare before set, so re-running is a no-op.
// - Installations are never modified: a missing membership prints the exact
//   maintainer UI step instead.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createAppJwt } from './configure-github-app-webhook.mjs';
import { createApi } from './verify-onboarding.mjs';

export const VARIABLE_NAMES = Object.freeze([
  'AGENT_BOT_LOGINS',
  'AGENT_FLEET_LOGIN',
  'AGENT_LCARS_CLIENT_ID',
]);
export const SECRET_NAME = 'AGENT_LCARS_PRIVATE_KEY';
export const STATUSES = Object.freeze([
  'PASS',
  'FAIL',
  'SKIP',
  'PLAN',
  'UNVERIFIED',
]);
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const INSTALLATION_NOTE =
  'installations are a maintainer UI step; this tool never modifies them';

export class ToolError extends Error {}
class UnverifiedError extends ToolError {}

// Only messages this tool wrote itself, or the status-only HTTP errors that
// createApi throws, may reach the report. Anything else could carry a value.
const safeMessage = (error) =>
  error instanceof ToolError || /^GitHub HTTP \d+$/.test(error?.message ?? '')
    ? error.message
    : 'request failed';

export function parseRepo(value, flag = '--repo') {
  if (!value || !REPO_PATTERN.test(value))
    throw new ToolError(`${flag} must be OWNER/NAME`);
  return value;
}

export function installationSettingsUrl(installation) {
  const login = installation.account?.login;
  return installation.account?.type === 'Organization'
    ? `https://github.com/organizations/${login}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}

// --- external command adapters (injected in tests) -----------------------

// gh(args, { input }) -> stdout. Values travel through `input` (stdin), never
// through args. Failures report the subcommand and exit code only.
export function createGh(spawn = spawnSync) {
  return (args, { input } = {}) => {
    const result = spawn('gh', args, {
      encoding: 'utf8',
      input: input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new ToolError(
        `gh ${args.slice(0, 2).join(' ')} failed${
          typeof result.status === 'number' ? ` (exit ${result.status})` : ''
        }`,
      );
    return result.stdout;
  };
}

// Runs the operator's key command through the shell and returns stdout. The
// output is never logged; a failure reports only that the command failed.
export function createKeyCommandRunner(spawn = spawnSync) {
  return (command) => {
    const result = spawn('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new ToolError('--private-key-command failed');
    return result.stdout;
  };
}

// Delegates to the existing label sync so there is one label writer. Without
// --apply it exits 1 on drift and prints one line per differing label; with
// --apply it prints one line per change. Only the count is reported here.
export function createLabelSync(spawn = spawnSync) {
  const script = fileURLToPath(
    new URL('./sync-github-labels.mjs', import.meta.url),
  );
  return ({ repo, apply }) => {
    const result = spawn(
      process.execPath,
      [script, `--repo=${repo}`, ...(apply ? ['--apply'] : [])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.error) throw new ToolError('label sync could not start');
    return {
      status: result.status,
      changes: result.stdout.split('\n').filter(Boolean).length,
    };
  };
}

// --- pure planning -------------------------------------------------------

// Resolves each variable's desired value: the same-named environment
// variable wins (APP_CLIENT_ID also serves AGENT_LCARS_CLIENT_ID, because
// they name the same fleet App), then `gh variable get` on --copy-from.
export function resolveDesiredVariables({ env, copyFrom, gh }) {
  const desired = {};
  for (const name of VARIABLE_NAMES) {
    const candidates = [env[name]];
    if (name === 'AGENT_LCARS_CLIENT_ID') candidates.push(env.APP_CLIENT_ID);
    const fromEnv = candidates.find((value) => value?.trim());
    if (fromEnv) {
      desired[name] = { value: fromEnv.trim(), source: 'env' };
      continue;
    }
    if (!copyFrom) continue;
    try {
      // gh prints the value followed by exactly one newline.
      const value = gh(['variable', 'get', name, '-R', copyFrom]).replace(
        /\r?\n$/,
        '',
      );
      desired[name] = { value, source: `copy-from ${copyFrom}` };
    } catch {
      desired[name] = { error: `unavailable from ${copyFrom}` };
    }
  }
  return desired;
}

export function resolvePrivateKey({ env, command, runCommand }) {
  for (const name of ['APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY'])
    if (env[name]?.trim()) return { key: env[name], source: name };
  if (!command) return undefined;
  const key = runCommand(command);
  if (!key?.trim())
    throw new ToolError('--private-key-command produced no output');
  return { key, source: '--private-key-command' };
}

// Decides what to do about one variable. `current` is the live value (or
// undefined when absent). Returns {status, detail, write?} where write is the
// value to send when the mode permits writing.
export function planVariable({ name, desired, current, mode }) {
  if (desired?.error) return { status: 'FAIL', detail: desired.error };
  if (!desired) {
    if (mode === 'verify')
      return current?.trim()
        ? {
            status: 'PASS',
            detail:
              'present; value not compared (set it in env or pass --copy-from to compare)',
          }
        : { status: 'FAIL', detail: 'absent' };
    return {
      status: 'FAIL',
      detail: `no value source; set ${name} in the environment or pass --copy-from OWNER/NAME`,
    };
  }
  if (current === desired.value)
    return { status: 'PASS', detail: `unchanged (matches ${desired.source})` };
  const verb = current === undefined ? 'create' : 'update';
  if (mode === 'verify')
    return {
      status: 'FAIL',
      detail:
        current === undefined ? 'absent' : `differs from ${desired.source}`,
    };
  if (mode === 'dry-run')
    return { status: 'PLAN', detail: `would ${verb} from ${desired.source}` };
  return {
    status: 'PASS',
    detail: `${verb}d from ${desired.source}`,
    write: desired.value,
  };
}

export function planSecret({ present, keySource, mode, rotate }) {
  if (mode === 'verify')
    return present
      ? { status: 'PASS', detail: 'present; value not comparable' }
      : { status: 'FAIL', detail: 'absent' };
  if (present && !rotate)
    return {
      status: 'SKIP',
      detail: 'present; pass --rotate-secret to replace it',
    };
  if (!keySource)
    return {
      status: 'FAIL',
      detail:
        'no private key source; set APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY, or pass --private-key-command',
    };
  if (mode === 'dry-run')
    return { status: 'PLAN', detail: `would set from ${keySource}` };
  return { status: 'PASS', detail: `set from ${keySource}`, write: true };
}

export function hasFailure(facts) {
  return facts.some((fact) => fact.status === 'FAIL');
}

// --- GitHub App installation membership -----------------------------------

async function pages(api, path, token, key) {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = await api(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      token,
    );
    const batch = key ? result?.[key] : result;
    if (!Array.isArray(batch))
      throw new ToolError('unexpected GitHub list response');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

// Read-only membership check: list the App's installations on the target
// owner, mint a metadata-read token per installation, page the repositories
// it can see, revoke the token, and report. Never changes an installation.
export async function checkInstallation({ api, jwt, repo }) {
  const owner = repo.split('/')[0].toLowerCase();
  const installations = (await pages(api, '/app/installations', jwt)).filter(
    (installation) => installation.account?.login?.toLowerCase() === owner,
  );
  if (!installations.length)
    throw new ToolError(
      `no installation on ${repo.split('/')[0]}; install the App for that account from its GitHub App settings page and select ${repo} (${INSTALLATION_NOTE})`,
    );
  let revokeFailed = false;
  const excluded = [];
  for (const installation of installations) {
    if (installation.suspended_at)
      throw new ToolError(`installation ${installation.id} is suspended`);
    const minted = await api(
      `/app/installations/${installation.id}/access_tokens`,
      jwt,
      'POST',
      { permissions: { metadata: 'read' } },
    );
    let visible;
    try {
      visible = await pages(
        api,
        '/installation/repositories',
        minted.token,
        'repositories',
      );
    } finally {
      try {
        await api('/installation/token', minted.token, 'DELETE');
      } catch {
        revokeFailed = true;
      }
    }
    if (
      visible.some(
        (item) => item.full_name?.toLowerCase() === repo.toLowerCase(),
      )
    )
      return {
        detail: `installation ${installation.id} includes ${repo} (${visible.length} repositories visible)`,
        revokeFailed,
      };
    excluded.push(installation);
  }
  const target = excluded[0];
  throw new ToolError(
    `not included in installation ${excluded.map((item) => item.id).join(', ')}; add ${repo} at ${installationSettingsUrl(target)} while keeping its existing repositories selected (${INSTALLATION_NOTE})`,
  );
}

// --- orchestration --------------------------------------------------------

export async function runOnboarding({
  repo,
  copyFrom,
  mode = 'apply',
  rotateSecret = false,
  skipLabels = false,
  skipInstallations = false,
  privateKeyCommand,
  env = process.env,
  gh = createGh(),
  api = createApi(),
  runCommand = createKeyCommandRunner(),
  labelSync = createLabelSync(),
  labelManifest,
}) {
  parseRepo(repo);
  if (copyFrom) parseRepo(copyFrom, '--copy-from');
  if (copyFrom && copyFrom.toLowerCase() === repo.toLowerCase())
    throw new ToolError('--copy-from must name a different repository');
  if (!['apply', 'dry-run', 'verify'].includes(mode))
    throw new ToolError(`unknown mode ${mode}`);
  const facts = [];
  const report = (fact, status, detail) =>
    facts.push({ repo, fact, status, detail });
  // Belt and braces: no code path may reach gh with a write outside apply.
  const write = (args, input) => {
    if (mode !== 'apply')
      throw new ToolError(`refusing to write in ${mode} mode`);
    gh(args, { input });
  };

  // (a) repository variables
  const desired = resolveDesiredVariables({ env, copyFrom, gh });
  let current;
  try {
    current = new Map(
      JSON.parse(
        gh(['variable', 'list', '-R', repo, '--json', 'name,value']),
      ).map(({ name, value }) => [name, value]),
    );
  } catch (error) {
    current = undefined;
    for (const name of VARIABLE_NAMES)
      report(`variable:${name}`, 'FAIL', safeMessage(error));
  }
  if (current)
    for (const name of VARIABLE_NAMES) {
      const plan = planVariable({
        name,
        desired: desired[name],
        current: current.get(name),
        mode,
      });
      try {
        if (plan.write !== undefined)
          write(['variable', 'set', name, '-R', repo], plan.write);
        report(`variable:${name}`, plan.status, plan.detail);
      } catch (error) {
        report(`variable:${name}`, 'FAIL', safeMessage(error));
      }
    }

  // Private key: resolved once, lazily, only when something needs it.
  let keyState;
  const privateKey = () => {
    if (!keyState) {
      try {
        keyState = {
          value: resolvePrivateKey({
            env,
            command: privateKeyCommand,
            runCommand,
          }),
        };
      } catch (error) {
        keyState = { error };
      }
    }
    if (keyState.error) throw keyState.error;
    return keyState.value;
  };

  // (a) the App private key secret
  try {
    const present = JSON.parse(
      gh(['secret', 'list', '-R', repo, '--json', 'name']),
    ).some((secret) => secret.name === SECRET_NAME);
    const needsKey = mode !== 'verify' && (!present || rotateSecret);
    const key = needsKey ? privateKey() : undefined;
    const plan = planSecret({
      present,
      keySource: key?.source,
      mode,
      rotate: rotateSecret,
    });
    if (plan.write) write(['secret', 'set', SECRET_NAME, '-R', repo], key.key);
    report(`secret:${SECRET_NAME}`, plan.status, plan.detail);
  } catch (error) {
    report(`secret:${SECRET_NAME}`, 'FAIL', safeMessage(error));
  }

  // (b) App installation membership, read-only
  const apps = [
    {
      name: 'fleet',
      clientId:
        env.APP_CLIENT_ID?.trim() || desired.AGENT_LCARS_CLIENT_ID?.value,
      key: () => privateKey()?.key,
      hint: 'APP_CLIENT_ID and APP_PRIVATE_KEY',
    },
    {
      name: 'autoscaler',
      clientId: env.RUNNER_APP_CLIENT_ID?.trim(),
      key: () =>
        env.RUNNER_APP_PRIVATE_KEY?.trim() && env.RUNNER_APP_PRIVATE_KEY,
      hint: 'RUNNER_APP_CLIENT_ID and RUNNER_APP_PRIVATE_KEY',
    },
  ];
  for (const app of apps) {
    const fact = `installation:${app.name}`;
    if (skipInstallations) {
      report(fact, 'SKIP', 'not requested');
      continue;
    }
    try {
      const key = app.key();
      if (!app.clientId || !key)
        throw new UnverifiedError(
          `${app.name} App credential unavailable (${app.hint})`,
        );
      let jwt;
      try {
        jwt = createAppJwt(app.clientId, key);
      } catch {
        throw new ToolError(`${app.name} App JWT could not be created`);
      }
      const { detail, revokeFailed } = await checkInstallation({
        api,
        jwt,
        repo,
      });
      report(fact, 'PASS', detail);
      if (revokeFailed)
        report(
          `${fact}:token-revocation`,
          'FAIL',
          'could not revoke temporary read token',
        );
    } catch (error) {
      report(
        fact,
        error instanceof UnverifiedError ? 'UNVERIFIED' : 'FAIL',
        safeMessage(error),
      );
    }
  }

  // (c) labels, through the existing sync
  if (skipLabels) report('labels', 'SKIP', 'not requested');
  else {
    try {
      const manifest =
        labelManifest ??
        JSON.parse(
          readFileSync(
            new URL('../config/github-labels.json', import.meta.url),
            'utf8',
          ),
        );
      if (!manifest.repositories?.[repo])
        throw new ToolError(
          'repository not declared in config/github-labels.json; run fleet-onboard.mjs admit first',
        );
      const result = labelSync({ repo, apply: mode === 'apply' });
      if (mode === 'apply') {
        if (result.status !== 0) throw new ToolError('label sync failed');
        report(
          'labels',
          'PASS',
          result.changes
            ? `${result.changes} label(s) created or updated`
            : 'declared labels already match',
        );
      } else if (result.status === 0)
        report('labels', 'PASS', 'declared labels match');
      else if (result.status === 1 && result.changes)
        report(
          'labels',
          mode === 'dry-run' ? 'PLAN' : 'FAIL',
          `${result.changes} label(s) ${mode === 'dry-run' ? 'would be' : 'need to be'} created or updated`,
        );
      else throw new ToolError('label sync failed');
    } catch (error) {
      report('labels', 'FAIL', safeMessage(error));
    }
  }
  return facts;
}

// --- CLI ------------------------------------------------------------------

const USAGE = `usage:
  fleet-onboard-github.mjs --repo OWNER/NAME [--copy-from OWNER/NAME]
      [--private-key-command CMD] [--dry-run | --verify] [--rotate-secret]
      [--skip-labels] [--skip-installations]

Sets ${VARIABLE_NAMES.join(', ')} and the ${SECRET_NAME}
secret on the target repository, checks that the fleet and autoscaler App
installations include it, and runs the label sync. Values come only from
same-named environment variables or \`gh variable get\` on --copy-from; the
private key comes only from APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY, or
--private-key-command. Installation checks use APP_CLIENT_ID/APP_PRIVATE_KEY
and RUNNER_APP_CLIENT_ID/RUNNER_APP_PRIVATE_KEY (UNVERIFIED when absent).
Output is one JSON line per fact; no value is ever printed.`;

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        repo: { type: 'string' },
        'copy-from': { type: 'string' },
        'private-key-command': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        'rotate-secret': { type: 'boolean', default: false },
        'skip-labels': { type: 'boolean', default: false },
        'skip-installations': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new ToolError(error.message);
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  return {
    help: false,
    repo: parseRepo(values.repo),
    copyFrom: values['copy-from'],
    privateKeyCommand: values['private-key-command'],
    mode: values.verify ? 'verify' : values['dry-run'] ? 'dry-run' : 'apply',
    rotateSecret: values['rotate-secret'],
    skipLabels: values['skip-labels'],
    skipInstallations: values['skip-installations'],
  };
}

export async function main(argv, { log = console.log, ...deps } = {}) {
  const options = parseCli(argv);
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const facts = await runOnboarding({ ...options, ...deps });
  for (const fact of facts) log(JSON.stringify(fact));
  return hasFailure(facts) ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Never print a stack or a foreign message: it could carry a value.
      console.error(`fleet-onboard-github: ${safeMessage(error)}`);
      process.exitCode = 2;
    });
}
