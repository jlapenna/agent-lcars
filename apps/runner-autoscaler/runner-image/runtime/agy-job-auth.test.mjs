/* eslint-disable vitest/no-import-node-test -- installed native runtime contract */
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { agyJobAuth } from './agy-job-auth.mjs';

test('Antigravity recipe harness provisions a private native login, evaluator runner and model, then removes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-job-auth-'));
  try {
    const tokenFile = join(root, 'antigravity-oauth-token');
    await writeFile(tokenFile, '{"fixture":"only"}\n');
    const environment = {};
    const auth = await agyJobAuth({
      environment,
      model: 'gemini-4-argon-medium',
      tokenFile,
      root,
    });
    const app = environment.REPO_EVAL_ANTIGRAVITY_AUTH_DIR;
    assert.match(app, /\/lcars-agy-[^/]+\/antigravity-cli$/u);
    assert.equal(
      await readFile(join(app, 'antigravity-oauth-token'), 'utf8'),
      '{"fixture":"only"}\n',
    );
    assert.equal((await stat(join(app, '..'))).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(app, 'antigravity-oauth-token'))).mode & 0o777,
      0o600,
    );
    assert.equal(environment.REPO_SKILL_EVALS_RUNNER, 'antigravity');
    assert.equal(environment.REPO_SKILL_EVALS_MODEL, 'gemini-4-argon-medium');
    await auth.close();
    assert.deepEqual(environment, {});
    assert.deepEqual(await readdir(root), ['antigravity-oauth-token']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Antigravity recipe harness fails closed without a model or a usable projected token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-job-auth-'));
  try {
    const environment = {};
    const tokenFile = join(root, 'antigravity-oauth-token');
    await writeFile(tokenFile, 'token');
    await assert.rejects(
      agyJobAuth({ environment, tokenFile, root }),
      /requires a providerModel/u,
    );
    await assert.rejects(
      agyJobAuth({ environment, model: 'bad model', tokenFile, root }),
      /requires a providerModel/u,
    );
    await assert.rejects(
      agyJobAuth({
        environment,
        model: 'm',
        tokenFile: join(root, 'missing'),
        root,
      }),
    );
    const blank = join(root, 'blank');
    await writeFile(blank, '  \n');
    await assert.rejects(
      agyJobAuth({ environment, model: 'm', tokenFile: blank, root }),
      /Invalid Antigravity credential/u,
    );
    assert.deepEqual(environment, {});
    assert.deepEqual((await readdir(root)).sort(), [
      'antigravity-oauth-token',
      'blank',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
