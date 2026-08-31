import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function currentSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return currentSourceFiles(path);
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('strict persisted-record cutover residue guard', () => {
  it('leaves no production migration endpoint, manifest, or compatibility parser', () => {
    const files = [
      ...currentSourceFiles(join(repoRoot, 'libs/orchestrator/src')),
      ...currentSourceFiles(join(repoRoot, 'apps/console/src/lib')),
      join(repoRoot, 'apps/console/apphosting.yaml'),
    ];
    const retired = [
      'orchestrator-migration',
      'persisted-record-migration',
      'PersistedMigration',
      'parsePersistedRun',
      'persistedRunSchema',
      "by: 'infra'",
      'work.migrate',
    ];
    const residue = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return retired
        .filter((term) => source.includes(term))
        .map((term) => `${file}: ${term}`);
    });
    expect(residue).toEqual([]);
  });

  it('accepts only the current Run pipeline in the direct runner', () => {
    const source = readFileSync(
      join(repoRoot, 'apps/runner-autoscaler/runner-image/direct-runner.sh'),
      'utf8',
    );
    expect(source).toContain("jq -r '.pipeline // empty'");
    expect(source).not.toContain('.spec.pipeline');
  });
});
