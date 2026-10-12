import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const gateTest = path.join(
  repoRoot,
  'agents/shared/skills/agent-protocol/scripts/check-pr-closing-references.test.sh',
);

describe('closing-scope gate fail-fast chaining (#2534)', () => {
  it('runs the published checker chained to a next-step witness: wrong scope and changed head invoke no witness, the declared scope admits it', () => {
    const output = execFileSync('bash', [gateTest], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain(
      'ok: the published closing-scope guard blocks a chained next step',
    );
  }, 120_000);
});
