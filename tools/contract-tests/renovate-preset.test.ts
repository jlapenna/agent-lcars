import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type RenovateConfig = {
  packageRules?: Array<Record<string, unknown>>;
  toolSettings?: Record<string, unknown>;
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

  it("gives every pnpm 11 consumer pnpm's 24-hour release-age policy", async () => {
    const preset = await readRenovateConfig('renovate-preset.json');
    const localConfig = await readRenovateConfig('renovate.json');

    expect(preset.packageRules).toContainEqual({
      description: expect.stringContaining('minimumReleaseAge'),
      matchManagers: ['npm'],
      minimumReleaseAge: '1 day',
    });
    expect(localConfig.packageRules).not.toContainEqual(
      expect.objectContaining({ minimumReleaseAge: expect.anything() }),
    );
  });

  it("bounds Node memory for pnpm artifact updates inside Mend's recommended range", async () => {
    const preset = await readRenovateConfig('renovate-preset.json');

    // Integer MiB; Mend recommends 1.5-2.5 GB for pnpm/yarn repos that hit
    // hosted timeout or kernel-out-of-memory limits.
    expect(preset.toolSettings?.nodeMaxMemory).toSatisfy(
      (value: unknown) =>
        Number.isInteger(value) &&
        (value as number) >= 1536 &&
        (value as number) <= 2560,
    );
  });
});
