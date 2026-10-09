#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const DEFAULT_PORT_BASE = 4300;
const LOCAL_USER = 'e2e-agent-lcars-admin';
const LOOPBACK = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 120_000;

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..');
const consoleRoot = path.join(root, 'apps/console');
const fixtureFile = path.join(root, 'tools/e2e/ci.env');
const validatorFile = path.join(root, 'tools/e2e/validate-env.mjs');
const firebaseCli = path.join(
  root,
  'node_modules/firebase-tools/lib/bin/firebase.js',
);

export function buildPorts(base) {
  if (!Number.isInteger(base) || base < 1024 || base > 65_529) {
    throw new Error('port base must be an integer from 1024 through 65529');
  }
  return {
    console: base,
    ui: base + 1,
    firestore: base + 2,
    auth: base + 3,
    hub: base + 4,
    logging: base + 5,
    firestoreWebsocket: base + 6,
  };
}

export function createFirebaseConfig(ports) {
  const endpoint = (port) => ({ host: LOOPBACK, port });
  return {
    emulators: {
      ui: { enabled: true, ...endpoint(ports.ui) },
      auth: endpoint(ports.auth),
      firestore: {
        ...endpoint(ports.firestore),
        websocketPort: ports.firestoreWebsocket,
      },
      hub: endpoint(ports.hub),
      logging: endpoint(ports.logging),
      singleProjectMode: true,
    },
  };
}

export function parseArguments(argv, environment = process.env) {
  let command = 'start';
  let portBase = Number(
    environment.AGENT_LCARS_DEV_PORT_BASE ?? DEFAULT_PORT_BASE,
  );
  let seed = true;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (['start', 'reset', 'status'].includes(argument)) {
      if (command !== 'start' || index !== 0) {
        throw new Error(`unexpected command: ${argument}`);
      }
      command = argument;
    } else if (argument === '--port-base') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--port-base requires a value');
      portBase = Number(value);
      index += 1;
    } else if (argument.startsWith('--port-base=')) {
      portBase = Number(argument.slice('--port-base='.length));
    } else if (argument === '--no-seed') {
      seed = false;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (command !== 'start' && !seed) {
    throw new Error('--no-seed is valid only with start');
  }
  return { command, help, ports: buildPorts(portBase), seed };
}

export function createDevEnvironment({
  ambient,
  fixture,
  ports,
  privateKey,
  tempHome,
}) {
  const publicUrl = `http://${LOOPBACK}:${ports.console}`;
  const projectId = 'demo-no-project';
  const safeAmbientKeys = [
    'JAVA_HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
  ];
  const result = {};
  for (const key of safeAmbientKeys) {
    if (ambient[key]) result[key] = ambient[key];
  }

  return {
    ...result,
    ...fixture,
    HOME: tempHome,
    TMPDIR: path.join(tempHome, 'tmp'),
    NODE_ENV: 'development',
    NODE_OPTIONS: '--max-old-space-size=8192',
    NEXT_TELEMETRY_DISABLED: '1',
    // The emulator SDKs otherwise spend seconds probing the cloud metadata
    // service for ambient credentials on every fresh development process.
    METADATA_SERVER_DETECTION: 'none',
    E2E_TESTING: 'true',
    PROJECT_ID: projectId,
    GCLOUD_PROJECT: projectId,
    AUTH_URL: publicUrl,
    FIRESTORE_EMULATOR_HOST: `${LOOPBACK}:${ports.firestore}`,
    FIREBASE_AUTH_EMULATOR_HOST: `${LOOPBACK}:${ports.auth}`,
    FIREBASE_EMULATOR_HUB: `${LOOPBACK}:${ports.hub}`,
    AGENT_CONSOLE_GITHUB_API_BASE_URL: `${publicUrl}/api/e2e/github`,
    AGENT_LCARS_CONSOLE_URL: publicUrl,
    AGENT_LCARS_ARTIFACT_SHARE_BASE_URL: `${publicUrl}/dummy-share`,
    AGENT_LCARS_APP_PRIVATE_KEY: privateKey,
    FIREBASE_EMULATORS_PATH: path.join(
      ambient.HOME ?? tempHome,
      '.cache/firebase/emulators',
    ),
  };
}

function usage() {
  return `Agent LCARS local development stack

Usage:
  pnpm dev [-- --port-base 4300] [--no-seed]
  pnpm dev:reset [-- --port-base 4300]
  pnpm dev:status [-- --port-base 4300]

The stack runs only against synthetic GitHub data and a demo Firebase project.
Choose a different seven-port range with --port-base when another stack is up.`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      reject(
        new Error(
          `port ${port} is unavailable (${error.code ?? error.message}); ` +
            'choose another range with --port-base',
        ),
      );
    });
    probe.listen(port, LOOPBACK, () => probe.close(resolve));
  });
}

function processIdentity(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'linux') return String(pid);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

export async function stopEmulatorProcesses(processes) {
  for (const [pid, identity] of processes) {
    if (identity && processIdentity(pid) === identity) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (
      [...processes].every(
        ([pid, identity]) => processIdentity(pid) !== identity,
      )
    )
      return;
    await wait(50);
  }
  for (const [pid, identity] of processes) {
    if (identity && processIdentity(pid) === identity) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
  }
}

export function trackEmulatorProcesses(emulators, ownedProcesses) {
  for (const emulator of Object.values(emulators)) {
    if (Number.isInteger(emulator.pid) && emulator.pid > 0) {
      const identity = processIdentity(emulator.pid);
      if (identity) ownedProcesses.set(emulator.pid, identity);
    }
  }
}

async function waitForFirebase(ports, child, ownedProcesses) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const url = `http://${LOOPBACK}:${ports.hub}/emulators`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Firebase emulators exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const emulators = await response.json();
        trackEmulatorProcesses(emulators, ownedProcesses);
        if (
          ['auth', 'firestore', 'ui', 'logging'].every(
            (name) => emulators[name],
          )
        )
          return;
      }
    } catch {
      // Startup polling intentionally ignores connection failures.
    }
    await wait(250);
  }
  throw new Error('Firebase emulators did not become ready within 120 seconds');
}

async function inspectStack(ports) {
  const response = await fetch(
    `http://${LOOPBACK}:${ports.console}/__dev/health`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok)
    throw new Error(`development stack health: HTTP ${response.status}`);
  const health = await response.json();
  if (
    health.service !== 'agent-lcars-dev' ||
    health.worktree !== root ||
    health.portBase !== ports.console
  ) {
    throw new Error("port is not serving this worktree's development stack");
  }
  return health;
}

export async function updateFixtures(ports, actions) {
  await inspectStack(ports);
  for (const action of actions) {
    const response = await fetch(
      `http://${LOOPBACK}:${ports.console}/api/e2e/seed`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-e2e-auth-user': LOCAL_USER,
        },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        `fixture ${action} failed: ${response.status} ${await response.text()}`,
      );
    }
  }
}

async function status(ports) {
  const url = `http://${LOOPBACK}:${ports.console}`;
  try {
    const health = await inspectStack(ports);
    if (!health.ready)
      throw new Error('still warming routes and seeding fixtures');
    console.log(`ready ${url}`);
  } catch (error) {
    console.error(`not ready ${url}: ${error.message}`);
    process.exitCode = 1;
  }
}

export function validateDevelopmentEnvironment(nextRoot = consoleRoot) {
  const validation = spawnSync(
    process.execPath,
    [
      validatorFile,
      fixtureFile,
      path.join(nextRoot, '.env.development.local'),
      path.join(nextRoot, '.env.development'),
      '--next-root',
      nextRoot,
    ],
    { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' },
  );
  if (validation.status !== 0) {
    throw new Error(
      validation.stderr?.trim() ||
        'local fixture environment validation failed',
    );
  }
}

async function start(ports, seed) {
  const startedAt = Date.now();
  const checkedPorts = Object.values(ports);
  await Promise.all(checkedPorts.map((port) => assertPortAvailable(port)));
  validateDevelopmentEnvironment();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lcars-dev-'));
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(path.join(tempHome, 'tmp'), { recursive: true });
  const firebaseConfig = path.join(tempRoot, 'firebase.json');
  fs.writeFileSync(
    firebaseConfig,
    `${JSON.stringify(createFirebaseConfig(ports), null, 2)}\n`,
  );

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const fixture = parseEnv(fs.readFileSync(fixtureFile, 'utf8'));
  const devEnvironment = createDevEnvironment({
    ambient: process.env,
    fixture,
    ports,
    privateKey,
    tempHome,
  });

  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, devEnvironment);

  const firebase = spawn(
    process.execPath,
    [
      firebaseCli,
      'emulators:start',
      '--only',
      'auth,firestore',
      '--project',
      devEnvironment.PROJECT_ID,
      '--config',
      firebaseConfig,
    ],
    {
      cwd: tempRoot,
      env: devEnvironment,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    },
  );

  let shuttingDown = false;
  let cleanup;
  let app;
  let server;
  let ready = false;
  const sockets = new Set();
  const ownedEmulatorProcesses = new Map();
  const stop = (signal = 'SIGTERM') => {
    if (shuttingDown) return cleanup;
    shuttingDown = true;
    cleanup = (async () => {
      if (server) {
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await Promise.race([closed, wait(2_000)]);
      }
      if (app) {
        await Promise.race([app.close(), wait(2_000)]).catch((error) => {
          console.error(`Next shutdown: ${error.message}`);
        });
      }
      if (firebase.exitCode === null && firebase.signalCode === null) {
        firebase.kill(signal);
        await Promise.race([
          new Promise((resolve) => firebase.once('exit', resolve)),
          wait(5_000),
        ]);
        if (firebase.exitCode === null && firebase.signalCode === null) {
          if (process.platform === 'win32') firebase.kill('SIGKILL');
          else process.kill(-firebase.pid, 'SIGKILL');
          await new Promise((resolve) => firebase.once('exit', resolve));
        }
      }
      // Firebase's Java emulator starts a separate process group. Clean it up
      // even if the CLI crashed or had to be killed during shutdown.
      await stopEmulatorProcesses(ownedEmulatorProcesses);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    })();
    return cleanup;
  };

  const stopForSignal = (signal) => {
    void stop(signal).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => {
    if (!shuttingDown) stopForSignal('SIGINT');
  });
  process.on('SIGTERM', () => {
    if (!shuttingDown) stopForSignal('SIGTERM');
  });
  process.on('SIGHUP', () => {
    if (!shuttingDown) stopForSignal('SIGHUP');
  });
  firebase.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `Firebase emulators stopped unexpectedly (${signal ?? `code ${code}`})`,
    );
    void stop().finally(() => process.exit(1));
  });

  try {
    await waitForFirebase(ports, firebase, ownedEmulatorProcesses);
    // Next reads process configuration when loaded. Import it only after
    // replacing ambient credentials with the validated fixture environment.
    // eslint-disable-next-line no-restricted-syntax
    const next = (await import('next')).default;
    app = next({
      dev: true,
      dir: consoleRoot,
      hostname: LOOPBACK,
      port: ports.console,
    });
    await app.prepare();
    const handle = app.getRequestHandler();
    const upgrade = app.getUpgradeHandler();
    const authenticate = (request) => {
      request.headers['x-e2e-auth-user'] ??= LOCAL_USER;
    };
    server = http.createServer((request, response) => {
      if (request.url === '/__dev/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            service: 'agent-lcars-dev',
            worktree: root,
            portBase: ports.console,
            ready,
          }),
        );
        return;
      }
      authenticate(request);
      void handle(request, response);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      authenticate(request);
      void upgrade(request, socket, head);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(ports.console, LOOPBACK, resolve);
    });

    if (seed) await updateFixtures(ports, ['seed-populated']);
    const warm = await fetch(`http://${LOOPBACK}:${ports.console}`, {
      headers: { 'x-e2e-auth-user': LOCAL_USER },
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
    if (!warm.ok)
      throw new Error(`console warmup failed with HTTP ${warm.status}`);
    await warm.arrayBuffer();
    ready = true;

    console.log('');
    console.log(
      `Agent LCARS development stack ready in ${(
        (Date.now() - startedAt) /
        1_000
      ).toFixed(1)}s`,
    );
    console.log(`  Console:     http://${LOOPBACK}:${ports.console}`);
    console.log(`  Emulator UI: http://${LOOPBACK}:${ports.ui}`);
    console.log(`  Fixtures:    ${seed ? 'populated' : 'not seeded'}`);
    console.log('  Stop:        Ctrl-C');
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.command === 'status') {
    await status(options.ports);
  } else if (options.command === 'reset') {
    await updateFixtures(options.ports, ['reset', 'seed-populated']);
    console.log(
      `reset synthetic fixtures at http://${LOOPBACK}:${options.ports.console}`,
    );
  } else {
    await start(options.ports, options.seed);
  }
}

if (path.resolve(process.argv[1] ?? '') === scriptFile) {
  main().catch((error) => {
    console.error(`agent-lcars dev: ${error.message}`);
    process.exit(1);
  });
}
