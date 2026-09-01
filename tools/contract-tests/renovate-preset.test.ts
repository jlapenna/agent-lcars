import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type RenovateConfig = {
  packageRules?: Array<Record<string, unknown>>;
};

async function readRenovateConfig(path: string): Promise<RenovateConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as RenovateConfig;
}

describe('shared Renovate preset', () => {
  it('blocks only the known-incompatible TypeScript 7 line for every consumer', async () => {
    const preset = await readRenovateConfig('renovate-preset.json');
    const localConfig = await readRenovateConfig('renovate.json');

    expect(preset.packageRules).toContainEqual({
      description: expect.stringContaining('TypeScript 7'),
      matchPackageNames: ['typescript'],
      allowedVersions: '<7 || >=8',
    });
    expect(localConfig.packageRules).not.toContainEqual(
      expect.objectContaining({ matchPackageNames: ['typescript'] }),
    );
  });
});
