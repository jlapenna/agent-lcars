/* eslint-disable vitest/no-import-node-test -- runs with node --test inside the runner image gate (direct-runner.test.sh), without Vitest. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadGooseEnvironment,
  validateGooseEnvironment,
} from './goose-environment.mjs';

const files = (map) => (file) => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (!(name in map))
    return Promise.reject(
      Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }),
    );
  return Promise.resolve(JSON.stringify(map[name]));
};
const base = {
  GOOSE_PROVIDER: 'litellm',
  GOOSE_MODEL: 'default',
  LITELLM_API_KEY: 'k',
};

test('the shared environment is used unchanged', async () => {
  assert.deepEqual(
    await loadGooseEnvironment({
      read: files({ 'goose-environment.json': base }),
    }),
    base,
  );
});

test('the shared environment follows the provider environment rules', async () => {
  await assert.rejects(
    loadGooseEnvironment({
      read: files({ 'goose-environment.json': { LCARS_RUN_TOKEN: 'no' } }),
    }),
    /Invalid Goose provider environment \(goose-environment\.json\)/,
  );
  assert.throws(
    () =>
      validateGooseEnvironment(
        { GOOGLE_APPLICATION_CREDENTIALS: '/x' },
        'base',
      ),
    /base/,
  );
  assert.throws(() => validateGooseEnvironment(['a'], 'base'), /base/);
  assert.throws(() => validateGooseEnvironment({ A: 1 }, 'base'), /base/);
});
