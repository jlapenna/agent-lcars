import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const image = 'apps/runner-autoscaler/runner-image/';
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const config = json('renovate.json');
const releases = json(image + 'runtime-releases.json').releases as Array<{
  repository: string;
  version: string;
  architecture: string;
  asset: string;
  sha256: string;
}>;

function extracted(path: string) {
  return config.customManagers.flatMap(
    (manager: {
      managerFilePatterns: string[];
      matchStrings: string[];
      depNameTemplate?: string;
    }) => {
      if (
        !manager.managerFilePatterns.some((pattern) =>
          new RegExp(pattern.slice(1, -1)).test(path),
        )
      )
        return [];
      return manager.matchStrings.flatMap((pattern) =>
        [...read(path).matchAll(new RegExp(pattern, 'g'))].map((match) => ({
          depName: manager.depNameTemplate,
          ...match.groups,
        })),
      );
    },
  );
}

describe('native runtime dependency declarations', () => {
  it.each([
    ['anomalyco/opencode', 'opencode-version'],
    ['google-antigravity/antigravity-cli', 'agy-version'],
  ])(
    'registers %s and both platform locks with the updater',
    (repository, selector) => {
      const version = read(image + selector).trim();
      const platforms = releases.filter(
        (release) => release.repository === repository,
      );
      expect(platforms.map((release) => release.architecture).sort()).toEqual([
        'amd64',
        'arm64',
      ]);
      expect(
        platforms.every(
          (release) =>
            release.version === version &&
            /^[a-f0-9]{64}$/.test(release.sha256),
        ),
      ).toBe(true);
      expect(extracted(image + selector)).toEqual([
        { depName: repository, currentValue: version },
      ]);
      const locks = extracted(image + 'runtime-releases.json');
      for (const release of platforms) {
        expect(locks).toContainEqual({
          depName: repository,
          currentValue: version,
          currentDigest: release.sha256,
        });
      }
    },
  );

  it('keeps the npm CLI manifest and lock usable on both fleet architectures', () => {
    const manifest = json(image + 'runtime-clis/package.json');
    const lock = json(image + 'runtime-clis/package-lock.json');
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
    for (const name of ['@openai/codex', '@anthropic-ai/claude-code']) {
      expect(lock.packages['node_modules/' + name].version).toBe(
        manifest.dependencies[name],
      );
      for (const architecture of ['x64', 'arm64']) {
        const binary =
          lock.packages['node_modules/' + name + '-linux-' + architecture];
        expect(binary.cpu).toContain(architecture);
        expect(binary.os).toContain('linux');
        expect(binary.integrity).toMatch(/^sha512-/);
      }
    }
  });
});
