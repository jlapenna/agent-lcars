#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { lookup } from 'node:dns/promises';
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
  let fqdn = environment.FQDN || undefined;
  let lan = false;

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
    } else if (argument === '--fqdn') {
      lan = true;
      fqdn = argv[++index];
      if (!fqdn) throw new Error('--fqdn requires a value');
    } else if (argument.startsWith('--fqdn=')) {
      lan = true;
      fqdn = argument.slice('--fqdn='.length);
      if (!fqdn) throw new Error('--fqdn requires a value');
    } else if (argument === '--lan') {
      lan = true;
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
  if (lan && !fqdn) {
    throw new Error(
      'LAN preview requires FQDN or --fqdn (a fully qualified DNS name)',
    );
  }
  fqdn = lan ? validatePreviewFqdn(fqdn) : undefined;
  return { command, fqdn, help, lan, ports: buildPorts(portBase), seed };
}

export function validatePreviewFqdn(value) {
  const fqdn = value.toLowerCase();
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  if (
    fqdn.length > 253 ||
    !fqdn.includes('.') ||
    net.isIP(fqdn) ||
    !fqdn.split('.').every((part) => label.test(part))
  ) {
    throw new Error(
      'preview FQDN must be a fully qualified DNS name, not an IP or URL',
    );
  }
  return fqdn;
}

async function resolvePreviewAddress(fqdn) {
  if (!fqdn) return undefined;
  const addresses = await lookup(fqdn, { all: true, family: 4 });
  const local = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const address = addresses.find((record) =>
    local.some(
      (network) =>
        !network.internal &&
        network.family === 'IPv4' &&
        network.address === record.address,
    ),
  )?.address;
  if (!address)
    throw new Error(
      `preview FQDN ${fqdn} does not resolve to this host's LAN interface`,
    );
  const octets = address.split('.').map(Number);
  const privateAddress =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  if (!privateAddress)
    throw new Error(
      'fixture-authenticated preview requires a private LAN address',
    );
  return address;
}

export function isPreviewRequestAllowed(request, ports, fqdn) {
  const authorities = new Set([`${LOOPBACK}:${ports.console}`]);
  if (fqdn) authorities.add(`${fqdn}:${ports.console}`);
  if (!authorities.has(request.headers.host?.toLowerCase())) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && authorities.has(url.host);
  } catch {
    return false;
  }
}

export function createDevEnvironment({
  ambient,
  fixture,
  ports,
  privateKey,
  tempHome,
  fqdn,
}) {
  const publicUrl = `http://${fqdn ?? LOOPBACK}:${ports.console}`;
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
    ...(fqdn ? { FQDN: fqdn } : {}),
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
    AGENT_CONSOLE_GITHUB_API_BASE_URL: `http://${LOOPBACK}:${ports.console}/api/e2e/github`,
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
  FQDN=<host.example.net> pnpm dev:lan [-- --port-base 4300]
  pnpm dev:reset [-- --port-base 4300]
  pnpm dev:status [-- --port-base 4300]

The stack runs only against synthetic GitHub data and a demo Firebase project.
Choose a different seven-port range with --port-base when another stack is up.`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertPortAvailable(port, host = LOOPBACK) {
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
    probe.listen(port, host, () => probe.close(resolve));
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

export async function inspectStack(ports, fqdn) {
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
    health.portBase !== ports.console ||
    (fqdn && health.fqdn !== fqdn)
  ) {
    throw new Error("port is not serving this worktree's development stack");
  }
  return health;
}

export async function updateFixtures(ports, actions, fqdn) {
  await inspectStack(ports, fqdn);
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

async function status(ports, fqdn) {
  let url = `http://${LOOPBACK}:${ports.console}`;
  try {
    const health = await inspectStack(ports, fqdn);
    url = `http://${health.fqdn ?? LOOPBACK}:${ports.console}`;
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

async function start(ports, seed, fqdn) {
  const startedAt = Date.now();
  const previewAddress = await resolvePreviewAddress(fqdn);
  const checkedPorts = Object.values(ports);
  await Promise.all(checkedPorts.map((port) => assertPortAvailable(port)));
  if (previewAddress) await assertPortAvailable(ports.console, previewAddress);
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
    fqdn,
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
  let previewServer;
  let ready = false;
  const sockets = new Set();
  const ownedEmulatorProcesses = new Map();
  const stop = (signal = 'SIGTERM') => {
    if (shuttingDown) return cleanup;
    shuttingDown = true;
    cleanup = (async () => {
      for (const listener of [previewServer, server].filter(Boolean)) {
        const closed = new Promise((resolve) => listener.close(resolve));
        listener.closeAllConnections();
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
    server = http.createServer();
    app = next({
      dev: true,
      dir: consoleRoot,
      hostname: fqdn ?? LOOPBACK,
      port: ports.console,
      httpServer: server,
    });
    await app.prepare();
    const handle = app.getRequestHandler();
    const authenticate = (request) => {
      request.headers['x-e2e-auth-user'] ??= LOCAL_USER;
    };
    const handleRequest = (request, response) => {
      if (!isPreviewRequestAllowed(request, ports, fqdn)) {
        response.writeHead(403);
        response.end('Preview host or origin is not allowed');
        return;
      }
      if (request.url === '/__dev/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            service: 'agent-lcars-dev',
            worktree: root,
            portBase: ports.console,
            fqdn,
            ready,
          }),
        );
        return;
      }
      authenticate(request);
      void handle(request, response);
    };
    const trackSocket = (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    };
    const handleUpgrade = (listener, request, socket, head) => {
      if (!isPreviewRequestAllowed(request, ports, fqdn)) {
        socket.destroy();
        return;
      }
      authenticate(request);
      if (listener !== server) {
        // Next installs its development websocket handler on httpServer.
        // The LAN listener must use that same handler for HMR and hydration.
        server.emit('upgrade', request, socket, head);
      }
    };
    const listen = async (listener, address) => {
      listener.on('connection', trackSocket);
      listener.on('upgrade', (request, socket, head) =>
        handleUpgrade(listener, request, socket, head),
      );
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(ports.console, address, resolve);
      });
    };
    server.on('request', handleRequest);
    await listen(server, LOOPBACK);
    if (previewAddress) {
      previewServer = http.createServer((request, response) => {
        let pathname;
        try {
          pathname = decodeURIComponent(
            new URL(request.url, `http://${fqdn}:${ports.console}`).pathname,
          );
        } catch {
          response.writeHead(400);
          response.end('Invalid preview path');
          return;
        }
        if (
          pathname === '/api/e2e/github' ||
          pathname.startsWith('/api/e2e/github/')
        ) {
          response.writeHead(404);
          response.end('Not Found');
          return;
        }
        handleRequest(request, response);
      });
      await listen(previewServer, previewAddress);
    }

    if (seed) await updateFixtures(ports, ['seed-populated'], fqdn);
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
    console.log(`  Console:     http://${fqdn ?? LOOPBACK}:${ports.console}`);
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
    await status(options.ports, options.fqdn);
  } else if (options.command === 'reset') {
    const health = await inspectStack(options.ports, options.fqdn);
    await updateFixtures(
      options.ports,
      ['reset', 'seed-populated'],
      options.fqdn,
    );
    console.log(
      `reset synthetic fixtures at http://${health.fqdn ?? LOOPBACK}:${options.ports.console}`,
    );
  } else {
    await start(
      options.ports,
      options.seed,
      options.lan ? options.fqdn : undefined,
    );
  }
}

if (path.resolve(process.argv[1] ?? '') === scriptFile) {
  main().catch((error) => {
    console.error(`agent-lcars dev: ${error.message}`);
    process.exit(1);
  });
}
