/* eslint-disable vitest/no-import-node-test -- installed native runtime contract */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { codexJobAuth } from './codex-job-auth.mjs';

test('recipe provider restore/persist retains exact generation and erases its private auth home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-job-auth-'));
  const environment = {};
  const bytes = Buffer.from('{"tokens":{"access_token":"fixture-only"}}');
  const calls = [];
  try {
    const auth = await codexJobAuth({
      root,
      environment,
      signal: new AbortController().signal,
      request: async (method, body) => {
        calls.push({ method, body });
        return Response.json(
          method === 'GET'
            ? {
                generation: '7',
                sha256: createHash('sha256').update(bytes).digest('hex'),
                authBase64: bytes.toString('base64'),
              }
            : { status: 'unchanged' },
        );
      },
    });
    const file = join(environment.CODEX_HOME, 'auth.json');
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(environment.REPO_SKILL_EVALS_RUNNER, 'codex');
    await auth.persist();
    assert.equal(calls[1].body.generation, '7');
    assert.equal(calls[1].body.authBase64, bytes.toString('base64'));
    await assert.rejects(auth.persist(), /already attempted/);
    await auth.close();
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.equal(environment.CODEX_HOME, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('an ambiguous persistence failure is not retried or rebased to another generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-job-auth-'));
  const environment = {};
  const bytes = Buffer.from('{}');
  let writes = 0;
  try {
    const auth = await codexJobAuth({
      root,
      environment,
      signal: new AbortController().signal,
      request: async (method) => {
        if (method === 'PUT') {
          writes++;
          throw Error('lost response');
        }
        return Response.json({
          generation: '9',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          authBase64: bytes.toString('base64'),
        });
      },
    });
    await assert.rejects(auth.persist(), /lost response/);
    await assert.rejects(auth.persist(), /already attempted/);
    assert.equal(writes, 1);
    await auth.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
