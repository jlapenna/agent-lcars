import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  function recoveryFixture(smokeFails = false) {
    const file = handler(`
const fs = require('node:fs');
const receipt = __filename + '.calls';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const first = !fs.existsSync(receipt);
fs.appendFileSync(receipt, input.tool_input.command + '\\n');
if (first) throw new Error('private crash detail');
console.log(JSON.stringify({hookSpecificOutput: {
  hookEventName: 'PreToolUse',
  permissionDecision: ${smokeFails ? "'allow'" : "input.tool_input.command === 'git commit --no-verify' ? 'deny' : 'allow'"}
}}));
`);
    const contextPath = file + '.context';
    const env = {
      LCARS_WORKER_CONTEXT: contextPath,
      LCARS_RUN_ID: 'work:test/r1',
    };
    writeFileSync(
      contextPath,
      JSON.stringify({
        policyVersion: 1,
        provider: 'codex',
        runId: env.LCARS_RUN_ID,
        attemptId: 'g1:work:test/r1',
      }),
    );
    return {
      file,
      env,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo intended action' },
      }),
    };
  }
  it('restarts a failed evaluator, proves both controls, then reevaluates once', () => {
    const { file, env, input } = recoveryFixture();
    expect(
      bridge.invoke(file, input, { env }).hookSpecificOutput.permissionDecision,
    ).toBe('allow');
    expect(
      readFileSync(file + '.calls', 'utf8')
        .trim()
        .split('\n'),
    ).toEqual([
      'echo intended action',
      'echo LCARS_RECOVERY_READ_PROBE',
      'git commit --no-verify',
      'echo intended action',
    ]);
    expect(
      readFileSync(env.LCARS_WORKER_CONTEXT + '.recovery-used', 'utf8'),
    ).toBe('g1:work:test/r1');
    expect(
      readFileSync(env.LCARS_WORKER_CONTEXT + '.recovery-succeeded', 'utf8'),
    ).toBe('g1:work:test/r1');
    expect(existsSync(env.LCARS_WORKER_CONTEXT + '.control-failed')).toBe(
      false,
    );
    // A later hook process or resumed round cannot acquire another allowance.
    expect(
      bridge.recover(file, input, { env }).hookSpecificOutput
        .permissionDecision,
    ).toBe('deny');
    expect(
      readFileSync(file + '.calls', 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(4);
    expect(
      readFileSync(env.LCARS_WORKER_CONTEXT + '.control-failed', 'utf8'),
    ).toBe('g1:work:test/r1');
  });
  it('stops before reevaluating the action when the denial smoke fails', () => {
    const { file, env, input } = recoveryFixture(true);
    expect(
      bridge.invoke(file, input, { env }).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
    expect(
      readFileSync(file + '.calls', 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(3);
    expect(existsSync(env.LCARS_WORKER_CONTEXT + '.recovery-succeeded')).toBe(
      false,
    );
    expect(
      readFileSync(env.LCARS_WORKER_CONTEXT + '.control-failed', 'utf8'),
    ).toBe('g1:work:test/r1');
  });
  it('does not recover genuine policy denials or accept a foreign context', () => {
    const { file, env, input } = recoveryFixture();
    writeFileSync(
      file,
      decision({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      }),
    );
    expect(
      bridge.invoke(file, input, { env }).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
    expect(existsSync(env.LCARS_WORKER_CONTEXT + '.recovery-used')).toBe(false);
    expect(
      bridge.recover(file, input, {
        env: { ...env, LCARS_RUN_ID: 'work:other/r1' },
      }).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
    expect(existsSync(env.LCARS_WORKER_CONTEXT + '.recovery-used')).toBe(false);
  });
  it('bounds a hanging recovery and consumes its allowance without leaking errors', () => {
    const { file, env, input } = recoveryFixture();
    writeFileSync(file, 'setInterval(() => {}, 1000);');
    const started = Date.now();
    const result = bridge.recover(file, input, { env, timeout: 50 });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain(
      'infrastructure failure',
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(env.LCARS_WORKER_CONTEXT + '.recovery-used')).toBe(true);
  });
  it('uses the provisioned Node interpreter when loaded in a Bun host', () => {
    const previous = Object.getOwnPropertyDescriptor(process.versions, 'bun');
    Object.defineProperty(process.versions, 'bun', {
      value: 'fixture',
      configurable: true,
    });
    try {
      const { file, env, input } = recoveryFixture();
      expect(
        bridge.invoke(file, input, { env: { ...env, PATH: process.env.PATH } })
          .hookSpecificOutput.permissionDecision,
      ).toBe('allow');
    } finally {
      if (previous) Object.defineProperty(process.versions, 'bun', previous);
      else Reflect.deleteProperty(process.versions, 'bun');
    }
  });
  it('forwards only qualified native Bash rewrites', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'echo repaired' },
      },
    };
    expect(
      bridge.invoke(
        handler(decision(output)),
        JSON.stringify({ tool_name: 'Bash' }),
      ),
    ).toEqual(output);
    expect(
      bridge.invoke(
        handler(decision(output)),
        JSON.stringify({ tool_name: 'mcp_unknown' }),
      ).hookSpecificOutput.permissionDecision,
    ).toBe('deny');
    for (const updatedInput of [
      null,
      [],
      { command: 42 },
      { command: 'echo repaired', unknown: true },
    ]) {
      const invalid = {
        hookSpecificOutput: { ...output.hookSpecificOutput, updatedInput },
      };
      expect(
        bridge.invoke(
          handler(decision(invalid)),
          JSON.stringify({ tool_name: 'Bash' }),
        ).hookSpecificOutput.permissionDecision,
      ).toBe('deny');
    }
  });
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
