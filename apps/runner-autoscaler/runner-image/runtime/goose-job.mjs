import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agyJobAuth } from './agy-job-auth.mjs';
import { claudeJobAuth } from './claude-job-auth.mjs';
import { codexJobAuth } from './codex-job-auth.mjs';
import { loadGooseEnvironment } from './goose-environment.mjs';
import {
  cgroupAllocation,
  gooseExecutor,
  settleGooseFailure,
  subprocess,
} from './goose-executor.mjs';
import { applyJobSecrets } from './job-secret-environment.mjs';

// Invoked by direct-runner after activation, heartbeat and shared checkout/tool bootstrap.
// The shell owns periodic heartbeats, failure settlement and container retirement.
const required = (name) => {
  if (!process.env[name]) throw new Error(`${name} required`);
  return process.env[name];
};
const externalController = new AbortController();
const timeoutController = new AbortController();
const runSignal = AbortSignal.any([
  externalController.signal,
  timeoutController.signal,
]);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.once(signal, () => externalController.abort());
const base = `${required('LCARS_CONSOLE_URL')}/api/work/v1/runs/${encodeURIComponent(required('LCARS_RUN_ID'))}`;
async function call(path, body) {
  const activeSignal =
    path === 'complete' ? externalController.signal : runSignal;
  activeSignal.throwIfAborted();
  const headers = { Authorization: `Bearer ${required('LCARS_RUN_TOKEN')}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([activeSignal, AbortSignal.timeout(10000)]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Work API HTTP ${response.status}`);
  // The Work API refuses a recipe brief above REPOSITORY_JOB_BRIEF_MAX_BYTES
  // (8 MiB); credential delivery is at most 16 Secret Manager payloads of
  // 64 KiB, even fully JSON-escaped.
  const maximum = 8 * 1024 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum)
      throw new Error('Work API response exceeds supported size');
    chunks.push(chunk);
  }
  activeSignal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
let brief;
let home;
let secretHome;
let timeout;
let timedOut = false;
let codexAuth;
let claudeAuth;
let agyAuth;
try {
  brief = await call('recipe');
  await cgroupAllocation(brief.definition.job.execution.resources);
  // Job-specific credentials arrive below from the profile's credential set.
  const environment = await loadGooseEnvironment();
  // GitHub authority is supplied by the shared renewable command wrappers.
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) delete environment[key];
  home = await mkdtemp(join(tmpdir(), 'lcars-goose-profile-'));
  await mkdir(join(home, 'config'), { mode: 0o700 });
  await writeFile(
    join(home, 'config/config.yaml'),
    await readFile('/run/secrets/goose-config.yaml'),
    { flag: 'wx', mode: 0o600 },
  );
  Object.assign(environment, {
    PATH: process.env.PATH,
    HOME: required('HOME'),
    WORKSPACE: required('WORKSPACE'),
    REPOSITORY: required('REPOSITORY'),
    GOOSE_PATH_ROOT: home,
    TMPDIR: tmpdir(),
    GOOSE_DISABLE_KEYRING: 'true',
    HINDSIGHT_DISABLED: 'true',
  });
  if (brief.profile?.credentialSet) {
    secretHome = await mkdtemp(join('/dev/shm', 'lcars-job-secrets-'));
    await applyJobSecrets(
      await call('job-secrets'),
      environment,
      join(secretHome, 'files'),
    );
  }
  timeout = setTimeout(
    () => {
      timedOut = true;
      timeoutController.abort();
    },
    parseInt(brief.definition.job.execution.timeout, 10) * 60000,
  );
  // Use the same credential helper as coding runtimes to materialize the
  // admitted source revision; relative tool/skill reads must match the recipe.
  if (!/^[a-f0-9]{40}$/u.test(brief.definition.revision))
    throw new Error('Invalid recipe source revision');
  const workingDirectory = required('WORKSPACE');
  for (const args of [
    ['fetch', '--no-tags', 'origin', brief.definition.revision],
    ['checkout', '--detach', brief.definition.revision],
  ])
    await subprocess('git', args, {
      cwd: workingDirectory,
      environment,
      signal: runSignal,
    });
  if (brief.profile?.providerAuth === 'codex') {
    codexAuth = await codexJobAuth({
      signal: runSignal,
      environment,
      request: (method, body) =>
        fetch(`${base}/codex-auth`, {
          method,
          headers: {
            Authorization: `Bearer ${required('LCARS_RUN_TOKEN')}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal:
            method === 'PUT'
              ? AbortSignal.timeout(60000)
              : AbortSignal.any([runSignal, AbortSignal.timeout(60000)]),
          redirect: 'error',
        }),
    });
  }
  if (brief.profile?.providerAuth === 'claude')
    claudeAuth = await claudeJobAuth({ environment });
  if (brief.profile?.providerAuth === 'agy')
    agyAuth = await agyJobAuth({
      environment,
      model: brief.profile.providerModel,
    });
  const execute = gooseExecutor({
    workingDirectory,
    environment,
    assertAllocation: cgroupAllocation,
    resultFile: brief.profile?.resultFile,
    onProviderStarted: () =>
      call('heartbeat', { providerProcessStarted: true }),
  });
  let result;
  try {
    result = await execute({
      run: {
        definition: brief.definition,
        fileRecipeText: brief.fileRecipeText,
      },
      baseline: brief.baseline,
      parameters: brief.parameters,
      signal: runSignal,
    });
  } finally {
    clearTimeout(timeout);
  }
  runSignal.throwIfAborted();
  if (codexAuth) await codexAuth.persist();
  await call('recipe', { result });
} catch (error) {
  const aborted = externalController.signal.aborted;
  clearTimeout(timeout);
  const { settled } = await settleGooseFailure(error, {
    aborted,
    timedOut,
    timeoutMinutes: brief?.definition?.job?.execution?.timeout,
    codexAuth,
    complete: (payload) => call('complete', payload),
  });
  if (!settled) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  claudeAuth?.close();
  await agyAuth?.close();
  if (codexAuth) {
    try {
      if (!codexAuth.persistenceAttempted) await codexAuth.persist();
    } catch {
      console.error('Codex credential persistence failed after recipe failure');
      process.exitCode = 1;
    } finally {
      await codexAuth.close();
    }
  }
  if (home) await rm(home, { recursive: true, force: true });
  if (secretHome) await rm(secretHome, { recursive: true, force: true });
}
