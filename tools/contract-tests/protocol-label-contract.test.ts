import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const protocol = readFileSync(
  path.join(
    repoRoot,
    'agents/shared/skills/agent-protocol/reference/agent-protocol.md',
  ),
  'utf8',
);

interface LabelManifest {
  labels: Record<string, { color: string; description: string }>;
  repositories: Record<string, { labels: string[] }>;
}

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'config/github-labels.json'), 'utf8'),
) as LabelManifest;

const protocolCiLabels = [
  ...new Set(
    [...protocol.matchAll(/`(ci:[a-z0-9:-]+)`/g)].map((match) => match[1]),
  ),
].sort();

function repositoriesDeclaring(label: string): string[] {
  return Object.entries(manifest.repositories)
    .filter(([, profile]) => profile.labels.includes(label))
    .map(([repository]) => repository)
    .sort();
}

describe('published protocol CI label contract', () => {
  it('finds exact ci:* controls in the protocol', () => {
    expect(protocolCiLabels).toContain('ci:run-functional-e2e');
    expect(protocolCiLabels).toContain('ci:run-e2e');
  });

  it.each(protocolCiLabels)(
    '%s is declared and assigned by the canonical manifest',
    (label) => {
      expect(manifest.labels[label]).toBeDefined();
      expect(repositoriesDeclaring(label).length).toBeGreaterThan(0);
    },
  );

  it('scopes the functional pause override to its proven consumer', () => {
    expect(manifest.labels['ci:run-functional-e2e']?.description).toBe(
      'Run affected functional E2E while the default PR lane is paused',
    );
    expect(repositoriesDeclaring('ci:run-functional-e2e')).toEqual([
      'supersprinklesracing/sprinkles',
    ]);
  });
});
