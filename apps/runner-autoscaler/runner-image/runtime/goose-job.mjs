import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cgroupAllocation,
  gooseExecutor,
  subprocess,
} from './goose-executor.mjs';

// Invoked by direct-runner after activation, heartbeat and shared checkout/tool bootstrap.
// The shell owns periodic heartbeats, failure settlement and container retirement.
const required = (name) => {
  if (!process.env[name]) throw new Error(`${name} required`);
  return process.env[name];
};
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.once(signal, () => controller.abort());
const base = `${required('LCARS_CONSOLE_URL')}/api/work/v1/runs/${encodeURIComponent(required('LCARS_RUN_ID'))}`;
async function call(path, body) {
  controller.signal.throwIfAborted();
  const headers = { Authorization: `Bearer ${required('LCARS_RUN_TOKEN')}` };
  if (process.env.LCARS_CAPACITY_RECEIPT) {
    headers['x-lcars-worker-generation'] = required('LCARS_WORKER_GENERATION');
    headers['x-lcars-worker-identity'] = (
      await readFile(required('LCARS_WORKER_IDENTITY_FILE'), 'utf8')
    ).trim();
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Work API HTTP ${response.status}`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 262144) throw new Error('Recipe response exceeds 256 KiB');
    chunks.push(chunk);
  }
  controller.signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
let home;
let timeout;
try {
  const brief = await call('recipe');
  await cgroupAllocation(brief.definition.job.execution.resources);
  const environment = JSON.parse(
    await readFile('/run/secrets/goose-environment.json', 'utf8'),
  );
  if (
    !environment ||
    Array.isArray(environment) ||
    typeof environment !== 'object' ||
    Object.entries(environment).some(
      ([key, value]) =>
        typeof value !== 'string' ||
        key.startsWith('LCARS_') ||
        key === 'GOOGLE_APPLICATION_CREDENTIALS',
    )
  )
    throw new Error('Invalid Goose provider environment');
  // GitHub authority is supplied by the shared renewable command wrappers.
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RERUN_TOKEN'])
    delete environment[key];
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
  });
  timeout = setTimeout(
    () => controller.abort(),
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
      signal: controller.signal,
    });
  const execute = gooseExecutor({
    workingDirectory,
    environment,
    assertAllocation: cgroupAllocation,
    onProviderStarted: () =>
      call('heartbeat', { providerProcessStarted: true }),
  });
  const result = await execute({
    run: { definition: brief.definition },
    baseline: brief.baseline,
    parameters: brief.parameters,
    signal: controller.signal,
  });
  controller.signal.throwIfAborted();
  await call('recipe', { result });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Goose recipe failed');
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (home) await rm(home, { recursive: true, force: true });
}
