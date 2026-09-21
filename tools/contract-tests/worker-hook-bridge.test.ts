import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import bridge from '../../packages/fleet-tools/bin/worker-hook-bridge.cjs';

const roots: string[] = [];
function handler(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'lcars-hook-bridge-test-'));
  roots.push(root);
  const file = join(root, 'handler.cjs');
  writeFileSync(file, source);
  return file;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const decision = (value: unknown) =>
  `console.log(${JSON.stringify(JSON.stringify(value))});`;

describe('worker hook failure transport', () => {
  it.each(['allow', 'deny'])(
    'preserves explicit %s decisions',
    (permissionDecision) => {
      const output = {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision },
      };
      expect(bridge.invoke(handler(decision(output)), '{}')).toEqual(output);
    },
  );
  it.each([
    'throw new Error("secret fixture");',
    'process.exit(1);',
    'console.log("bad JSON");',
    decision({ continue: false }),
    decision({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
      },
    }),
  ])('denies handler failure without leaking diagnostics', (source) => {
    const output = bridge.invoke(handler(source), '{}');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.stringify(output)).not.toContain('secret fixture');
  });
  it('bounds a stuck handler and rejects missing handlers', () => {
    expect(
      bridge.invoke(handler('setInterval(() => {}, 1000);'), '{}', {
        timeout: 100,
      }).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
    expect(
      bridge.invoke('/nonexistent/lcars-test-handler.cjs', '{}')
        .hookSpecificOutput.permissionDecision,
    ).toBe('deny');
  });
  it('is silent in an interactive CLI invocation even with CI/session identity', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve('packages/fleet-tools/bin/worker-hook-bridge.cjs'),
        '/nonexistent/handler.cjs',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          CI: 'true',
          CODEX_THREAD_ID: 'interactive',
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
  it('activates only with explicit dispatch context', () => {
    expect(bridge.isDispatch({ LCARS_RUN_ID: 'work:test/r1' })).toBe(true);
    expect(bridge.isDispatch({ AGENT_DISPATCH_CONTEXT: '/tmp/brief' })).toBe(
      true,
    );
    expect(bridge.isDispatch({ CI: '1', LCARS_RUN_ID: ' ' })).toBe(false);
  });
});
