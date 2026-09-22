import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import session from '../../packages/fleet-tools/bin/worker-session.cjs';

const roots: string[] = [];
const context = {
  provider: 'codex',
  runId: 'work:test/r1',
  attemptId: 'g1:work:test/r1',
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-session-test-'));
  roots.push(root);
  return {
    LCARS_RUN_ID: context.runId,
    ATTEMPT_ID: context.attemptId,
    LCARS_WORKER_CONTEXT: join(root, 'context.json'),
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('binds the first native session and preserves it across repeated tool events', () => {
  const env = fixture();
  expect(
    session.rejection({ session_id: 'session-first' }, context, env),
  ).toBeNull();
  const before = readFileSync(
    env.LCARS_WORKER_CONTEXT + '.session.json',
    'utf8',
  );
  expect(
    session.rejection({ session_id: 'session-first' }, context, env),
  ).toBeNull();
  expect(
    session.rejection({ session_id: 'session-other' }, context, env),
  ).toContain('does not match');
  expect(readFileSync(env.LCARS_WORKER_CONTEXT + '.session.json', 'utf8')).toBe(
    before,
  );
});
it.each([false, true])(
  'publishes a complete binding under concurrent hooks (different sessions: %s)',
  async (different) => {
    const env = fixture();
    const invoke = (sessionId: string) =>
      new Promise<number | null>((done, reject) => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            'const session = require(process.argv[1]); process.exit(session.rejection(JSON.parse(process.argv[2]), JSON.parse(process.argv[3])) ? 1 : 0);',
            resolve('packages/fleet-tools/bin/worker-session.cjs'),
            JSON.stringify({ session_id: sessionId }),
            JSON.stringify(context),
          ],
          { env, stdio: 'ignore' },
        );
        child.on('error', reject);
        child.on('close', done);
      });
    const outcomes = await Promise.all([
      invoke('first-native-session'),
      invoke(different ? 'other-native-session' : 'first-native-session'),
    ]);
    expect(outcomes.filter((code) => code === 0)).toHaveLength(
      different ? 1 : 2,
    );
    expect(
      JSON.parse(
        readFileSync(env.LCARS_WORKER_CONTEXT + '.session.json', 'utf8'),
      ).attemptId,
    ).toBe(context.attemptId);
  },
);
it.each([undefined, '', '../session', 'contains spaces', 'x'.repeat(129)])(
  'rejects invalid native session metadata: %s',
  (session_id) => {
    const env = fixture();
    expect(session.rejection({ session_id }, context, env)).not.toBeNull();
    expect(existsSync(env.LCARS_WORKER_CONTEXT + '.session.json')).toBe(false);
  },
);
it('rejects a session different from the setup-known session before binding', () => {
  const env = fixture();
  expect(
    session.rejection(
      { session_id: 'other' },
      { ...context, nativeSessionId: 'expected' },
      env,
    ),
  ).not.toBeNull();
  expect(existsSync(env.LCARS_WORKER_CONTEXT + '.session.json')).toBe(false);
  expect(
    session.rejection(
      { session_id: 'expected' },
      { ...context, nativeSessionId: 'expected' },
      env,
    ),
  ).toBeNull();
});
it('rejects foreign run/attempt context and linked or malformed records', () => {
  const env = fixture(),
    input = { session_id: 'native-session' };
  expect(
    session.rejection(input, context, {
      ...env,
      LCARS_RUN_ID: 'work:other/r1',
    }),
  ).not.toBeNull();
  expect(
    session.rejection(input, context, {
      ...env,
      ATTEMPT_ID: 'g2:work:test/r2',
    }),
  ).not.toBeNull();
  const target = env.LCARS_WORKER_CONTEXT + '.foreign';
  writeFileSync(target, 'untouched');
  symlinkSync(target, env.LCARS_WORKER_CONTEXT + '.session.json');
  expect(session.rejection(input, context, env)).not.toBeNull();
  expect(readFileSync(target, 'utf8')).toBe('untouched');
});
