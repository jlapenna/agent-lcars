import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildPorts,
  createDevEnvironment,
  DEFAULT_PORT_BASE,
  isPreviewRequestAllowed,
  parseArguments,
  stopEmulatorProcesses,
  trackEmulatorProcesses,
  validateDevelopmentEnvironment,
} from './dev-console.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('local development stack contract', () => {
  it('discovers a loopback stack for status despite an ambient LAN FQDN', async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          service: 'agent-lcars-dev',
          worktree: root,
          portBase: server.address().port,
          ready: true,
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const child = spawn(
        process.execPath,
        [
          path.join(root, 'tools/dev-console.mjs'),
          'status',
          '--port-base',
          String(port),
        ],
        {
          env: { ...process.env, FQDN: 'unrelated.example.net' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      expect(code).toBe(0);
      expect(stdout).toContain(`ready http://127.0.0.1:${port}`);
      expect(stdout).not.toContain('unrelated.example.net');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('requires a real DNS FQDN for a LAN preview', () => {
    expect(
      parseArguments(['start'], { FQDN: 'dev.example.net' }),
    ).toMatchObject({ lan: false });
    expect(parseArguments(['--fqdn', 'dev.example.net'], {})).toMatchObject({
      lan: true,
    });
    expect(
      parseArguments(['start', '--lan'], { FQDN: 'dev.example.net' }),
    ).toMatchObject({ fqdn: 'dev.example.net' });
    expect(() => parseArguments(['start', '--lan'], {})).toThrow(
      /requires FQDN/u,
    );
    for (const fqdn of [
      'localhost',
      '192.168.1.2',
      'https://dev.example.net',
      'dev.example.net:4300',
      'dev.example.net/path',
    ]) {
      expect(() => parseArguments(['--fqdn', fqdn], {})).toThrow(
        /fully qualified/u,
      );
    }
  });

  it('rejects DNS rebinding and cross-origin requests before fixture authentication', () => {
    const ports = buildPorts(4300);
    const allowed = (host, origin) =>
      isPreviewRequestAllowed(
        { headers: { host, origin } },
        ports,
        'dev.example.net',
      );
    expect(allowed('dev.example.net:4300', 'http://dev.example.net:4300')).toBe(
      true,
    );
    expect(allowed('127.0.0.1:4300')).toBe(true);
    expect(allowed('attacker.example:4300')).toBe(false);
    expect(allowed('dev.example.net:4300', 'https://attacker.example')).toBe(
      false,
    );
    expect(allowed('dev.example.net:4300', 'null')).toBe(false);
    expect(allowed('dev.example.net:4300', 'http://dev.example.net:4301')).toBe(
      false,
    );
  });

  it('uses the FQDN for browser URLs but keeps backend emulators and fixtures private', () => {
    const environment = createDevEnvironment({
      ambient: {},
      fixture: {},
      ports: buildPorts(4300),
      privateKey: '',
      tempHome: '/tmp/dev-home',
      fqdn: 'dev.example.net',
    });
    expect(environment).toMatchObject({
      FQDN: 'dev.example.net',
      AUTH_URL: 'http://dev.example.net:4300',
      AGENT_CONSOLE_GITHUB_API_BASE_URL: 'http://127.0.0.1:4300/api/e2e/github',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:4302',
    });
  });
  it('cleans up a detached emulator that ignores graceful shutdown', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready");',
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const exit = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      await new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
      });
      const owned = new Map();
      trackEmulatorProcesses({ firestore: { pid: child.pid } }, owned);
      await stopEmulatorProcesses(owned);
      expect(await exit).toMatchObject({ signal: 'SIGKILL' });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
  });

  it('supports lifecycle commands and explicit concurrent ranges', () => {
    expect(
      parseArguments(['status', '--', '--port-base', '4700']).ports.console,
    ).toBe(4700);
    expect(
      parseArguments(['reset'], { AGENT_LCARS_DEV_PORT_BASE: '4800' }),
    ).toMatchObject({ command: 'reset', ports: { console: 4800 } });
    expect(() => parseArguments(['wat'])).toThrow(/unknown argument/u);
    expect(() => parseArguments(['--port-base', '65530'])).toThrow(
      /port base/u,
    );
    expect(() => parseArguments(['--port-base'])).toThrow(/requires a value/u);
  });

  it('constructs a synthetic child environment without ambient credentials', () => {
    const environment = createDevEnvironment({
      ambient: {
        HOME: '/home/developer',
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'must-not-cross-boundary',
      },
      fixture: { AUTH_SECRET: 'dummy-secret' },
      ports: buildPorts(DEFAULT_PORT_BASE),
      privateKey: 'ephemeral-private-key',
      tempHome: '/tmp/dev-home',
    });
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).toMatchObject({
      HOME: '/tmp/dev-home',
      PROJECT_ID: 'demo-no-project',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:4302',
      AUTH_URL: 'http://127.0.0.1:4300',
      E2E_TESTING: 'true',
    });
  });

  it('rejects development dotenv credentials without exposing their value', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lcars-dev-env-test-'),
    );
    try {
      for (const filename of ['.env.development', '.env.development.local']) {
        const file = path.join(directory, filename);
        fs.writeFileSync(
          file,
          'PROVIDER_API_KEY=sentinel-must-not-be-logged\n',
        );
        let message = '';
        try {
          validateDevelopmentEnvironment(directory);
        } catch (error) {
          message = error.message;
        }
        expect(message).toContain('PROVIDER_API_KEY');
        expect(message).not.toContain('sentinel-must-not-be-logged');
        fs.unlinkSync(file);
      }
      expect(() => validateDevelopmentEnvironment(directory)).not.toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an occupied port without stopping the existing service', async () => {
    const existing = net.createServer((socket) => socket.end('still alive'));
    await new Promise((resolve) => existing.listen(0, '127.0.0.1', resolve));
    const port = existing.address().port;
    try {
      const child = spawn(
        process.execPath,
        [
          path.join(root, 'tools/dev-console.mjs'),
          'start',
          '--port-base',
          String(port),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve) => child.once('exit', resolve));
      expect(code).toBe(1);
      expect(stderr).toContain(`port ${port} is unavailable`);
      const payload = await new Promise((resolve, reject) => {
        let text = '';
        const socket = net.connect(port, '127.0.0.1');
        socket.on('data', (data) => {
          text += data;
        });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      expect(payload).toBe('still alive');
    } finally {
      await new Promise((resolve) => existing.close(resolve));
    }
  });
});
