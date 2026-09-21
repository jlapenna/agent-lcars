import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
