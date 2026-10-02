import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const maximumRootGuideBytes = 14_000;
const requiredRoutes = [
  '.agents/skills/agent-lcars-dev/SKILL.md',
  '.agents/skills/agent-protocol/SKILL.md',
  'ARCHITECTURE.md',
  'docs/README.md',
  'docs/lifecycle-systems.md',
  'docs/deployment-boundary.md',
  'docs/testing-policy.md',
  'docs/ci-control-flags.md',
] as const;

export function validateRootAgentGuide(content: string): string[] {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(content, 'utf8');

  if (bytes > maximumRootGuideBytes) {
    errors.push(
      `AGENTS.md is ${bytes} bytes; keep the root router at or below ${maximumRootGuideBytes} bytes`,
    );
  }

  for (const route of requiredRoutes) {
    if (!content.includes(route)) {
      errors.push(`AGENTS.md must route to ${route}`);
    }
  }

  if (content.includes('gh variable set ')) {
    errors.push(
      'AGENTS.md must route live control mutations to their owner instead of embedding commands',
    );
  }

  return errors;
}

describe('root agent context', () => {
  const guide = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');

  it('stays a compact router to authoritative owners', () => {
    expect(validateRootAgentGuide(guide)).toEqual([]);
  });

  it('rejects renewed root-guide accumulation', () => {
    const oversized = `${guide}\n${'historical detail '.repeat(600)}`;

    expect(validateRootAgentGuide(oversized)).toContainEqual(
      expect.stringContaining('keep the root router'),
    );
  });

  it.each(requiredRoutes)('rejects a missing %s route', (route) => {
    expect(
      validateRootAgentGuide(guide.split(route).join('missing-owner')),
    ).toContain(`AGENTS.md must route to ${route}`);
  });

  it('rejects embedded live-control mutation recipes', () => {
    const invalid = `${guide}\ngh variable set FLAG --body false`;

    expect(validateRootAgentGuide(invalid)).toContain(
      'AGENTS.md must route live control mutations to their owner instead of embedding commands',
    );
  });
});
