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

test('without an overlay the shared environment is used unchanged', async () => {
  assert.deepEqual(
    await loadGooseEnvironment({
      read: files({ 'goose-environment.json': base }),
    }),
    base,
  );
});

test('a profile overlay is merged over the shared environment and its keys win', async () => {
  const env = await loadGooseEnvironment({
    overlay: 'skill-evals',
    read: files({
      'goose-environment.json': base,
      'goose-environment.skill-evals.json': {
        CLAUDE_CODE_OAUTH_TOKEN: 't',
        GOOSE_MODEL: 'big',
      },
    }),
  });
  assert.deepEqual(env, {
    ...base,
    CLAUDE_CODE_OAUTH_TOKEN: 't',
    GOOSE_MODEL: 'big',
  });
});

test('an overlay the Secret does not carry fails the run instead of running on the shared environment', async () => {
  await assert.rejects(
    loadGooseEnvironment({
      overlay: 'skill-evals',
      read: files({ 'goose-environment.json': base }),
    }),
    /goose-environment\.skill-evals\.json is not provisioned/,
  );
});

test('overlay names and contents follow the shared environment rules', async () => {
  for (const overlay of ['Skill', 'a/b', '../x', '']) {
    await assert.rejects(
      loadGooseEnvironment({
        overlay,
        read: files({ 'goose-environment.json': base }),
      }),
      /overlay name/,
    );
  }
  await assert.rejects(
    loadGooseEnvironment({
      overlay: 'x',
      read: files({
        'goose-environment.json': base,
        'goose-environment.x.json': { LCARS_RUN_TOKEN: 'no' },
      }),
    }),
    /Invalid Goose provider environment \(goose-environment\.x\.json\)/,
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
