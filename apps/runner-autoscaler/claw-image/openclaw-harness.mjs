// OpenClaw as a claw harness, through its own ACP server.
//
// `openclaw acp` speaks ACP on stdio and forwards each prompt to a Gateway,
// so the launcher prepares OpenClaw's state, starts a Gateway on loopback
// inside the Job and then runs `openclaw acp` as the agent, exactly as it
// runs any other harness. Nothing here speaks ACP.
//
// Start sequence (each step fails the attempt closed):
//   1. Fresh state: writable config copy, OPENCLAW_STATE_DIR/CONFIG_PATH.
//   2. `openclaw config validate --json` must report valid: OpenClaw
//      silently ignores unknown keys.
//   3. `openclaw doctor --fix --non-interactive`; it must not change the
//      pinned config beyond its own `meta`/`wizard` stamps.
//   4. `openclaw approvals set --file` seeds the enforcing exec approvals.
//   5. The launch config: the pinned config plus this Job's workspace and a
//      loopback, token-protected Gateway.
//   6. `openclaw gateway run`, waited on until it reports ready.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { ClawFailure, stopGroup } from './claw-process.mjs';

// Enough for `config validate --json`; no other command's output is read.
const MAX_OUTPUT_CHARS = 1024 * 1024;
const GATEWAY_READY_MS = 300_000;
const GATEWAY_STOP_MS = 5_000;
// The Gateway's own line once it accepts work, after its log prefix. Earlier
// lines such as "spawn broker ready pid=…" must not match.
const GATEWAY_READY = /\[gateway\] ready$/u;
const stripAnsi = (text) =>
  // eslint-disable-next-line no-control-regex -- terminal colour codes
  text.replace(/\u001b\[[0-9;]*m/gu, '');

// Strip OpenClaw's own bookkeeping so the pinned config can be compared with
// what Doctor leaves behind. Anything else Doctor changes fails the attempt.
export function comparableConfig(config) {
  const { meta: _meta, wizard: _wizard, ...rest } = config;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  return value;
}

// Runs one OpenClaw command to completion in its own process group, so a
// timeout or a cancellation stops the whole tree.
export function run(command, args, { env, cwd, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let timedOut = false;
    const stop = () => stopGroup(child, GATEWAY_STOP_MS);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : undefined;
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    // stderr carries OpenClaw diagnostics; never forward it, since it can
    // echo resolved configuration.
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new ClawFailure('claw run was cancelled'));
      else resolve({ code, timedOut, stdout });
    });
  });
}

// A port nothing listens on. The Job's network namespace is its own, so the
// gap between choosing it and the Gateway binding it is not contended.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// What OpenClaw actually runs: the reviewed config, plus what only this Job
// knows. `agent exec` used to take the workspace as a flag; a Gateway turn
// reads it from the config, and bootstraps a workspace unless told not to.
export function launchConfig(pinned, { workspace, port, token }) {
  const defaults = pinned.agents?.defaults ?? {};
  return {
    ...pinned,
    agents: {
      ...pinned.agents,
      defaults: { skipBootstrap: true, ...defaults, workspace },
    },
    gateway: {
      ...pinned.gateway,
      mode: 'local',
      bind: 'loopback',
      port,
      auth: { mode: 'token', token },
    },
  };
}

export async function prepareState({
  agentDir,
  workRoot,
  workspace,
  openclaw,
  env,
  signal,
}) {
  const stateDir = await mkdtemp(join(workRoot, 'state-'));
  const pinned = JSON.parse(
    await readFile(join(agentDir, 'config.json'), 'utf8'),
  );
  const configPath = join(stateDir, 'agent-config.json');
  const write = (config) =>
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  await write(pinned);
  const childEnv = {
    ...env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_AUTO_UPDATE: '1',
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const validation = await run(openclaw, ['config', 'validate', '--json'], {
    env: childEnv,
    timeoutMs: 120_000,
    signal,
  });
  let valid;
  try {
    valid = JSON.parse(validation.stdout).valid === true;
  } catch {
    valid = false;
  }
  if (!valid) throw new ClawFailure('pinned OpenClaw config failed validation');

  const doctor = await run(openclaw, ['doctor', '--fix', '--non-interactive'], {
    env: childEnv,
    timeoutMs: 300_000,
    signal,
  });
  if (doctor.code !== 0 || doctor.timedOut)
    throw new ClawFailure(`openclaw doctor exited ${doctor.code}`);
  const after = JSON.parse(await readFile(configPath, 'utf8'));
  if (comparableConfig(after) !== comparableConfig(pinned))
    throw new ClawFailure(
      'openclaw doctor changed the pinned config; pin the Doctor-normalized config',
    );

  const approvals = await run(
    openclaw,
    ['approvals', 'set', '--file', join(agentDir, 'approvals.json')],
    { env: childEnv, timeoutMs: 120_000, signal },
  );
  if (approvals.code !== 0 || approvals.timedOut)
    throw new ClawFailure(`openclaw approvals set exited ${approvals.code}`);

  const gateway = {
    port: await freePort(),
    token: randomBytes(32).toString('hex'),
  };
  await write(launchConfig(after, { workspace, ...gateway }));
  const tokenFile = join(stateDir, 'gateway.token');
  await writeFile(tokenFile, `${gateway.token}\n`, { mode: 0o600 });
  return { stateDir, configPath, childEnv, port: gateway.port, tokenFile };
}

// Starts the Gateway in its own process group and resolves, once it reports
// ready, with the function that stops it.
export function startGateway(openclaw, { env, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const child = spawn(openclaw, ['gateway', 'run'], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise((done) => child.once('close', done));
    // SIGTERM, then SIGKILL for the whole group once the grace is over or
    // the Gateway itself has gone: whatever it left behind goes with it.
    const stop = async () => {
      stopGroup(child, GATEWAY_STOP_MS);
      await Promise.race([
        closed,
        new Promise((done) => setTimeout(done, GATEWAY_STOP_MS).unref()),
      ]);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    };
    let ready = false;
    let tail = '';
    const fail = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void stop().then(() => reject(error));
    };
    const timer = setTimeout(
      () => fail(new ClawFailure('OpenClaw Gateway was not ready in time')),
      GATEWAY_READY_MS,
    );
    timer.unref();
    const onAbort = () => fail(new ClawFailure('claw run was cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (ready) return;
      const lines = (tail + chunk).split('\n');
      tail = lines.pop().slice(-4096);
      if (!lines.some((line) => GATEWAY_READY.test(stripAnsi(line).trimEnd())))
        return;
      ready = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(stop);
    });
    // Gateway logs can echo resolved configuration; never forward them.
    child.stderr.resume();
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (ready) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal?.aborted
          ? new ClawFailure('claw run was cancelled')
          : new ClawFailure(
              `OpenClaw Gateway exited ${code} before it was ready`,
            ),
      );
    });
  });
}

/** The `openclaw` harness: OpenClaw's ACP server, bridged to a Gateway this
 * Job owns. */
export async function openclawHarness({
  definitionDir,
  workRoot,
  workspace,
  openclaw,
  env,
  signal,
}) {
  const { childEnv, port, tokenFile } = await prepareState({
    agentDir: definitionDir,
    workRoot,
    workspace,
    openclaw,
    env,
    signal,
  });
  const stop = await startGateway(openclaw, { env: childEnv, signal });
  return {
    command: openclaw,
    args: [
      'acp',
      '--url',
      `ws://127.0.0.1:${port}`,
      '--token-file',
      tokenFile,
      // The agent's working directory is its configured workspace; the
      // prompt carries exactly the message.
      '--no-prefix-cwd',
    ],
    env: childEnv,
    stop,
  };
}
