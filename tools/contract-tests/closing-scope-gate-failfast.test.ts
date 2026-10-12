import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const gateTest = path.join(
  repoRoot,
  'agents/shared/skills/agent-protocol/scripts/check-pr-closing-references.test.sh',
);

describe('closing-scope gate fail-fast chaining (#2534)', () => {
  it('executes published shared and interactive Ready/Arm procedures: rejection skips dependent actions, accepted scopes and head bindings are preserved', () => {
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
