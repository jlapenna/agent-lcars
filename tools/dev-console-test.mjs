import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import {
  buildPorts,
  createDevEnvironment,
  DEFAULT_PORT_BASE,
  inspectStack,
  updateFixtures,
  validatePreviewFqdn,
} from './dev-console.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  let base = Number(process.env.AGENT_LCARS_DEV_PORT_BASE ?? DEFAULT_PORT_BASE);
  const args = [];
  const input = process.argv.slice(2);
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === '--') continue;
    if (argument === '--port-base') base = Number(input[++index]);
    else if (argument.startsWith('--port-base=')) {
      base = Number(argument.slice('--port-base='.length));
    } else args.push(argument);
  }
  const ports = buildPorts(base);
  const health = await inspectStack(ports);
  if (!health.ready) throw new Error('development stack is still warming');
  const fqdn = health.fqdn ? validatePreviewFqdn(health.fqdn) : undefined;
  const baseUrl = `http://${fqdn ?? '127.0.0.1'}:${ports.console}`;
  const artifactRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lcars-dev-test-'),
  );
  const tempHome = path.join(artifactRoot, 'home');
  fs.mkdirSync(path.join(tempHome, 'tmp'), { recursive: true });
  const environment = createDevEnvironment({
    ambient: process.env,
    fixture: parseEnv(
      fs.readFileSync(path.join(root, 'tools/e2e/ci.env'), 'utf8'),
    ),
    ports,
    privateKey: '',
    tempHome,
    fqdn,
  });
  environment.BASE_URL = baseUrl;
  environment.LCARS_DEV_TEST_OUTPUT = artifactRoot;
  environment.PLAYWRIGHT_BROWSERS_PATH =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(
      process.env.HOME ?? '',
      process.platform === 'darwin'
        ? 'Library/Caches/ms-playwright'
        : '.cache/ms-playwright',
    );
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  if (args.length === 0) {
    args.push(
      'native-work.spec.ts',
      '--grep',
      'opens populated listing and saves title and description durably',
    );
  }
  console.log(`Testing the running stack at ${baseUrl}`);
  console.log(
    'Tests reset synthetic data; populated fixtures are restored afterward.',
  );
  let fixturesTouched = false;
  try {
    fixturesTouched = true;
    await updateFixtures(ports, ['reset', 'seed-populated'], fqdn);
    const child = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--config',
        'tools/dev-console.playwright.config.mts',
        ...args,
      ],
      { cwd: root, env: environment, stdio: 'inherit' },
    );
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    process.exitCode = status;
  } finally {
    try {
      if (fixturesTouched)
        await updateFixtures(ports, ['reset', 'seed-populated'], fqdn);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
      console.log(`Browser diagnostics: ${artifactRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(`agent-lcars dev:test: ${error.message}`);
  process.exitCode = 1;
});
