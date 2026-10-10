import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import test from 'vitest';

test('local admission checks the complete post-reserve envelope', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('capacity', 'tools/e2e-docker-capacity.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
gib = 1024**3
module.validate_fit(3, 12*gib, [44*gib, 44*gib])
for args in [(1, 32*gib, [100*gib]), (3, 11*gib, [100*gib]),
             (3, 32*gib, [43*gib, 100*gib]), (3, 32*gib, [])]:
    try:
        module.validate_fit(*args)
    except ValueError:
        continue
    raise AssertionError(f'oversized/unknown local fit accepted: {args}')
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
