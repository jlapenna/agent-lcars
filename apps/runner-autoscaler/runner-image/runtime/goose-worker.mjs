import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { cgroupAllocation, gooseExecutor } from './goose-executor.mjs';
import { verifyGooseStorage } from './goose-storage.mjs';

const required = (key) => {
  if (!process.env[key]) throw new Error(`${key} required`);
  return process.env[key];
};
const controller = new AbortController();
const role = required('LCARS_JOB_ROLE');
const shared = '/tmp/lcars-job';
await mkdir(shared, { recursive: true, mode: 0o700 });
async function publish(name, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 262144)
    throw new Error('Shared job data exceeds 256 KiB');
  const temporary = `${shared}/${name}.${role}.${process.pid}.tmp`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, `${shared}/${name}`);
}
async function readShared(name) {
  let file;
  try {
    file = await open(
      `${shared}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 262144)
      throw new Error('Invalid shared job data');
    const bytes = Buffer.alloc(262145);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 262144)
      throw new Error('Shared job data grew beyond limit');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}
async function waitFor(name, deadline) {
  while (Date.now() < deadline && !controller.signal.aborted) {
    const value = await readShared(name);
    if (value !== undefined) return value;
    if (await readShared('cancel')) throw new Error('Recipe canceled');
    await delay(250);
  }
  throw new Error('Recipe timed out or canceled');
}
async function verifyComponent(brief, bootstrap) {
  const whole = brief.definition.job.execution.resources.requests;
  const allocation = {
    cpu: bootstrap ? 0.1 : (Math.round(whole.cpu * 1000) - 100) / 1000,
    memory: `${bootstrap ? 256 : parseInt(whole.memory, 10) * 1024 - 256}Mi`,
    storage: whole.storage,
  };
  await cgroupAllocation(
    { requests: allocation, limits: allocation },
    {
      verifyStorage: () => verifyGooseStorage(whole.storage, whole.memory),
    },
  );
}
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

async function executeRecipe() {
  if (process.env.LCARS_RUN_TOKEN || process.env.LCARS_CAPACITY_RECEIPT)
    throw new Error('Recipe container received control-plane credentials');
  const brief = await waitFor('brief', Date.now() + 120000);
  await verifyComponent(brief, false);
  const environment = JSON.parse(
    await readFile('/etc/lcars/goose/environment.json', 'utf8'),
  );
  if (
    Object.keys(environment).some(
      (key) =>
        key.startsWith('LCARS_') || key === 'GOOGLE_APPLICATION_CREDENTIALS',
    )
  )
    throw new Error(
      'Control-plane credentials cannot enter recipe environment',
    );
  await mkdir('/tmp/goose/config', { recursive: true, mode: 0o700 });
  await writeFile(
    '/tmp/goose/config/config.yaml',
    await readFile('/etc/lcars/goose/config.yaml'),
    { flag: 'wx', mode: 0o600 },
  );
  Object.assign(environment, {
    HOME: '/tmp/goose',
    GOOSE_CONFIG_DIR: '/tmp/goose/config',
    TMPDIR: '/tmp',
  });
  const deadline = setTimeout(
    () => controller.abort(),
    parseInt(brief.definition.job.execution.timeout, 10) * 60000,
  );
  const cancellation = setInterval(() => {
    void readShared('cancel')
      .then((value) => {
        if (value) controller.abort();
      })
      .catch(() => controller.abort());
  }, 1000);
  try {
    const execute = gooseExecutor({
      environment,
      assertAllocation: () => verifyComponent(brief, false),
      onProviderStarted: () => publish('started', true),
    });
    const result = await execute({
      run: { definition: brief.definition },
      baseline: brief.baseline,
      signal: controller.signal,
    });
    if (controller.signal.aborted)
      throw new Error('Recipe canceled or timed out');
    await publish('result', { result });
  } finally {
    clearTimeout(deadline);
    clearInterval(cancellation);
  }
}

async function bootstrap() {
  const consoleURL = required('LCARS_CONSOLE_URL');
  const runId = required('LCARS_RUN_ID');
  const token = required('LCARS_RUN_TOKEN');
  let generation = undefined;
  async function call(path, body) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'x-lcars-worker-identity': (
        await readFile('/run/agent-lcars-identity/token', 'utf8')
      ).trim(),
    };
    if (generation !== undefined)
      headers['x-lcars-worker-generation'] = String(generation);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${consoleURL}/api/work/v1/runs/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Work API HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 262144) throw new Error('Work response too large');
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  }
  const activation = await call('activate', {
    fence: JSON.parse(required('LCARS_CAPACITY_RECEIPT')),
    jobUid: required('LCARS_CAPACITY_JOB_UID'),
  });
  generation = activation.generation;
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error('Invalid worker activation');
  const prefix = encodeURIComponent(runId);
  const brief = await call(`${prefix}/recipe`);
  if (brief.profile.image !== required('LCARS_GOOSE_IMAGE'))
    throw new Error('Worker image differs from admitted profile');
  await verifyComponent(brief, true);
  await call(`${prefix}/heartbeat`, {});
  await publish('brief', brief);
  let heartbeating = false;
  const heartbeat = setInterval(() => {
    if (heartbeating) return;
    heartbeating = true;
    void readShared('started')
      .then((started) =>
        call(
          `${prefix}/heartbeat`,
          started ? { providerProcessStarted: true } : {},
        ),
      )
      .catch(() => controller.abort())
      .finally(() => {
        heartbeating = false;
      });
  }, 15000);
  try {
    const value = await waitFor(
      'result',
      Date.now() + parseInt(brief.definition.job.execution.timeout, 10) * 60000,
    );
    if (value.error) throw new Error(String(value.error).slice(0, 2048));
    if (await readShared('started'))
      await call(`${prefix}/heartbeat`, { providerProcessStarted: true });
    await call(`${prefix}/recipe`, { result: value.result });
  } finally {
    clearInterval(heartbeat);
  }
}
try {
  if (role === 'bootstrap') await bootstrap();
  else if (role === 'recipe') await executeRecipe();
  else throw new Error('Unknown job container role');
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Recipe worker failed';
  if (role === 'bootstrap')
    await publish('cancel', true).catch(() => {
      /* Preserve the original failure if the shared volume is unavailable. */
    });
  else
    await publish('result', { error: message }).catch(() => {
      /* Preserve the original failure if the shared volume is unavailable. */
    });
  console.error(message);
  process.exitCode = 1;
}
