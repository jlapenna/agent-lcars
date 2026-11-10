/* eslint-disable vitest/no-import-node-test -- installed native runtime contract */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { claudeJobAuth } from './claude-job-auth.mjs';

test('Claude recipe harness exports the projected token and evaluator runner, then clears both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-job-auth-'));
  try {
    const tokenFile = join(root, 'claude-code-oauth-token');
    await writeFile(tokenFile, 'fixture-only-token\n');
    const environment = {};
    const auth = await claudeJobAuth({ environment, tokenFile });
    assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-only-token');
    assert.equal(environment.REPO_SKILL_EVALS_RUNNER, 'claude');
    auth.close();
    assert.deepEqual(environment, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude recipe harness fails closed without a usable projected token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-job-auth-'));
  try {
    const environment = {};
    await assert.rejects(
      claudeJobAuth({ environment, tokenFile: join(root, 'missing') }),
    );
    const blank = join(root, 'blank');
    await writeFile(blank, '  \n');
    await assert.rejects(
      claudeJobAuth({ environment, tokenFile: blank }),
      /Invalid Claude credential/u,
    );
    assert.deepEqual(environment, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
