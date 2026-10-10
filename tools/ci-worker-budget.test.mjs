import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import test from 'vitest';

for (const ci of ['true', '1']) {
  test(`CI=${ci} caps the actual Vitest factory after project overrides`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { createVitestConfig } from './vitest.config.base.mts';
      const config = createVitestConfig({ dirname: process.cwd(), projectName: 'budget-check',
        overrides: { test: { maxWorkers: 8, minWorkers: 4 } } });
      assert.equal(config.test.maxWorkers, 1);
      assert.equal(config.test.minWorkers, 1);
    `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, CI: ci, NX_TASK_TARGET_PROJECT: 'budget-check' },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
  });
}
