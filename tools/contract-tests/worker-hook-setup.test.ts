import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it } from 'vitest';

import setup from '../../packages/fleet-tools/bin/worker-hook-setup.cjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-setup-test-'));
  roots.push(root);
  const config = join(root, 'settings.json'),
    handler = join(root, 'handler.cjs');
  writeFileSync(handler, 'process.exit(0);');
  return { config, handler };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it.each([
  {
    name: 'no failure receipt',
    used: false,
    success: false,
    failure: false,
    foreign: false,
    wrongPath: false,
    failed: false,
  },
  {
    name: 'foreign failure receipt',
    used: false,
    success: false,
    failure: true,
    foreign: true,
    wrongPath: false,
    failed: false,
  },
  {
    name: 'exact failure receipt',
    used: false,
    success: false,
    failure: true,
    foreign: false,
    wrongPath: false,
    failed: true,
  },
  {
    name: 'interrupted recovery',
    used: true,
    success: false,
    failure: false,
    foreign: false,
    wrongPath: false,
    failed: true,
  },
  {
    name: 'successful recovery',
    used: true,
    success: true,
    failure: false,
    foreign: false,
    wrongPath: false,
    failed: false,
  },
  {
    name: 'failure after earlier recovery',
    used: true,
    success: true,
    failure: true,
    foreign: false,
    wrongPath: false,
    failed: true,
  },
  {
    name: 'foreign recovery success',
    used: true,
    success: true,
    failure: false,
    foreign: true,
    wrongPath: false,
    failed: true,
  },
  {
    name: 'unbound receipt location',
    used: false,
    success: false,
    failure: true,
    foreign: false,
    wrongPath: true,
    failed: false,
  },
])('classifies terminal control evidence: $name', (test) => {
  const root = dirname(fixture().config);
  const context = join(
    root,
    test.wrongPath ? 'foreign-context.json' : 'worker-policy-context.json',
  );
  const attempt = 'g1:work:test/r1';
  if (test.used) writeFileSync(context + '.recovery-used', attempt);
  for (const [enabled, suffix] of [
    [test.success, '.recovery-succeeded'],
    [test.failure, '.control-failed'],
  ] as const)
    if (enabled)
      writeFileSync(
        context + suffix,
        test.foreign ? 'g9:work:other/r9' : attempt,
      );
  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; worker_control_failed',
      '--',
      resolve(
        'apps/runner-autoscaler/runner-image/runtime/worker-policy-bootstrap.sh',
      ),
    ],
    {
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: root,
        LCARS_WORKER_CONTEXT: context,
        ATTEMPT_ID: attempt,
      },
    },
  );
  expect(result.status).toBe(test.failed ? 0 : 1);
});

it('installs a missing registration, preserves unrelated state, and repeats without a write', () => {
  const { config, handler } = fixture();
  const original = {
    theme: 'dark',
    hooks: {
      Stop: [{ hooks: [] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'unrelated' }] },
      ],
    },
  };
  writeFileSync(config, JSON.stringify(original));
  expect(setup.installRegistration(config, handler).changed).toBe(true);
  const installed = JSON.parse(readFileSync(config, 'utf8'));
  expect(installed.theme).toBe('dark');
  expect(installed.hooks.Stop).toEqual(original.hooks.Stop);
  expect(installed.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
  const first = readFileSync(config, 'utf8');
  expect(setup.installRegistration(config, handler).changed).toBe(false);
  expect(readFileSync(config, 'utf8')).toBe(first);
});

it('fails setup on missing or syntactically invalid handlers before changing config', () => {
  const { config, handler } = fixture();
  writeFileSync(config, '{}');
  expect(() =>
    setup.installRegistration(config, `${handler}.missing`),
  ).toThrow();
  writeFileSync(handler, 'const = broken;');
  expect(() => setup.installRegistration(config, handler)).toThrow();
  expect(readFileSync(config, 'utf8')).toBe('{}');
});

it('preserves malformed and linked configuration rather than overwriting it', () => {
  const { config, handler } = fixture();
  writeFileSync(config, '{broken');
  expect(() => setup.installRegistration(config, handler)).toThrow();
  expect(readFileSync(config, 'utf8')).toBe('{broken');
  const linked = `${config}.link`;
  symlinkSync(config, linked);
  expect(() => setup.installRegistration(linked, handler)).toThrow();
  const dangling = `${config}.dangling`;
  symlinkSync(`${config}.missing`, dangling);
  expect(() => setup.installRegistration(dangling, handler)).toThrow();
});

it('updates only the managed command on an installed handler-path change', () => {
  const { config, handler } = fixture();
  setup.installRegistration(config, handler);
  const next = `${handler}.next.cjs`;
  writeFileSync(next, 'process.exit(0);');
  expect(setup.installRegistration(config, next).changed).toBe(true);
  const groups = JSON.parse(readFileSync(config, 'utf8')).hooks.PreToolUse;
  expect(groups).toHaveLength(1);
  expect(groups[0].hooks[0].command).toContain(next);
});

it('installs OpenCode without dropping existing plugins and repeats without duplication', () => {
  const { config } = fixture();
  writeFileSync(
    config,
    JSON.stringify({ plugin: ['./existing.mjs'], permission: { bash: 'ask' } }),
  );
  expect(setup.installOpenCode(config).changed).toBe(true);
  const installed = JSON.parse(readFileSync(config, 'utf8'));
  expect(installed.plugin).toEqual([
    './existing.mjs',
    pathToFileURL(
      resolve('packages/fleet-tools/bin/worker-opencode-plugin.mjs'),
    ).href,
  ]);
  expect(installed.permission.bash).toBe('ask');
  expect(setup.installOpenCode(config).changed).toBe(false);
});

it.each(['claude', 'codex', 'opencode'])(
  'binds %s once and refuses identity replacement',
  (provider) => {
    const { config } = fixture();
    const contextPath = config + '.context';
    const briefPath = config + '.brief';
    writeFileSync(
      briefPath,
      JSON.stringify({
        repository: 'octo/example',
        mode: 'implement',
        anchor: { type: 'issue', number: 42 },
      }),
    );
    const options = {
      provider,
      configPath: config,
      contextPath,
      briefPath,
      runId: 'octo/example#42/r1',
      attemptId: 'g1:octo/example#42/r1',
    };
    expect(setup.prepareWorker(options)).toMatchObject({
      changed: true,
      executionSmokeRequired: true,
    });
    const binding = readFileSync(contextPath, 'utf8');
    expect(JSON.parse(binding)).toMatchObject({
      provider,
      attemptId: options.attemptId,
      mode: 'implement',
    });
    expect(setup.prepareWorker(options).changed).toBe(false);
    expect(() =>
      setup.prepareWorker({
        ...options,
        runId: 'octo/example#42/r2',
        attemptId: 'g2:octo/example#42/r2',
      }),
    ).toThrow();
    expect(readFileSync(contextPath, 'utf8')).toBe(binding);
  },
);

it('invalid identity fails before setup writes any state', () => {
  const { config } = fixture();
  const contextPath = config + '.context';
  const briefPath = config + '.brief';
  writeFileSync(
    briefPath,
    JSON.stringify({
      repository: 'octo/example',
      mode: 'implement',
      anchor: { type: 'issue', number: 42 },
    }),
  );
  expect(() =>
    setup.prepareWorker({
      provider: 'codex',
      configPath: config,
      contextPath,
      briefPath,
      runId: 'octo/example#42/r1',
      attemptId: 'wrong',
    }),
  ).toThrow();
  expect(existsSync(config)).toBe(false);
  expect(existsSync(contextPath)).toBe(false);
});

it.each(['claude', 'codex', 'opencode'])(
  'executes installed %s allow/deny controls during bootstrap',
  async (provider) => {
    const { config } = fixture();
    const briefPath = config + '.brief';
    writeFileSync(
      briefPath,
      JSON.stringify({
        repository: 'octo/example',
        mode: 'reply',
        anchor: { type: 'work', id: 'item' },
      }),
    );
    const options = {
      provider,
      configPath: config,
      contextPath: config + '.context',
      briefPath,
      runId: 'work:item/r1',
      attemptId: 'g1:work:item/r1',
    };
    expect(await setup.bootstrapWorker(options)).toMatchObject({
      controlSmokePassed: true,
      executionSmokeRequired: false,
    });
    expect(existsSync(options.contextPath + '.session.json')).toBe(false);
    writeFileSync(
      options.contextPath + '.session.json',
      'existing native binding',
    );
    expect((await setup.bootstrapWorker(options)).changed).toBe(false);
    expect(readFileSync(options.contextPath + '.session.json', 'utf8')).toBe(
      'existing native binding',
    );
    writeFileSync(config, '{}');
    await expect(
      setup.verifyControl(provider, config, options.contextPath),
    ).rejects.toThrow();
  },
);
