/* eslint-disable vitest/no-import-node-test -- runner helper contracts execute with node --test. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { applyJobSecrets } from './job-secret-environment.mjs';

test('materializes only selected bindings in private runtime files', async () => {
  const root = await mkdtemp('/dev/shm/lcars-secrets-test-');
  try {
    const environment = { HOME: '/fixture/home' };
    const directory = join(root, 'files');
    await applyJobSecrets(
      {
        environment: { EXAMPLE_API_KEY: 'fixture-api-key' },
        files: { certificate: 'fixture-certificate\n' },
      },
      environment,
      directory,
    );
    assert.equal(environment.EXAMPLE_API_KEY, 'fixture-api-key');
    assert.equal(environment.HOME, '/fixture/home');
    assert.equal(environment.LCARS_JOB_SECRET_FILES_DIR, directory);
    assert.equal(
      await readFile(join(directory, 'certificate'), 'utf8'),
      'fixture-certificate\n',
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(directory, 'certificate'))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('refuses runtime overrides and path traversal before exposing any bindings', async () => {
  for (const key of [
    'PATH',
    'GITHUB_TOKEN',
    'LCARS_RUN_TOKEN',
    'BASH_ENV',
    'WORKSPACE',
  ]) {
    const environment = {};
    await assert.rejects(
      applyJobSecrets(
        {
          environment: {
            EXAMPLE_API_KEY: 'fixture-key',
            [key]: 'fixture-private-value',
          },
          files: {},
        },
        environment,
        '/unused',
      ),
      /bindings refused/u,
    );
    assert.deepEqual(environment, {});
  }
  await assert.rejects(
    applyJobSecrets(
      { environment: {}, files: { '../escape': 'fixture-private-value' } },
      {},
      '/unused',
    ),
    /bindings refused/u,
  );
});
