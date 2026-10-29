import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The pinned node base image is the version Renovate's dockerfile manager
// moves. Every other copy of that release must follow it in the same PR:
// runner and E2E images are built only at publication, never in PR CI, so a
// partial bump passes Verify and then fails every publication. #3092 moved the
// FROM lines alone and control-plane-verify-runtime refused the build.
const read = (file: string) => readFileSync(file, 'utf8');

function versions(file: string, pattern: RegExp): string[] {
  return [...read(file).matchAll(pattern)].map((match) => match[1]);
}

const release = String.raw`(\d+\.\d+\.\d+)`;
const base = versions(
  'apps/runner-autoscaler/control-plane-image/Dockerfile',
  new RegExp(String.raw`^FROM node:${release}-slim@`, 'gm'),
);

const copies: [string, RegExp][] = [
  [
    'tools/e2e/Dockerfile',
    new RegExp(String.raw`^FROM node:${release}-slim@`, 'gm'),
  ],
  [
    'apps/runner-autoscaler/runner-image/Dockerfile',
    new RegExp(String.raw`^ARG NODE_BUILD_BASE=node:${release}-slim$`, 'gm'),
  ],
  // NodeSource apt pin for the runner image's own Node.
  [
    'apps/runner-autoscaler/runner-image/Dockerfile',
    new RegExp(String.raw`^ARG NODE_VERSION=${release}$`, 'gm'),
  ],
  // Assertions that the Node binary copied from the base image is that release.
  [
    'apps/runner-autoscaler/control-plane-image/verify-runtime.sh',
    new RegExp(String.raw`process\.versions\.node'\)" = ${release}`, 'g'),
  ],
  [
    'tools/e2e/Dockerfile',
    new RegExp(String.raw`process\.versions\.node'\)" = ${release}`, 'g'),
  ],
  [
    'tools/e2e-runner/Dockerfile',
    new RegExp(String.raw`process\.versions\.node'\)" = ${release}`, 'g'),
  ],
  // detect-baked.sh reuses the runner image's Node only on an exact match.
  [
    '.github/actions/setup-node-pnpm/action.yml',
    new RegExp(
      String.raw`node-version:\n(?:\s+[a-z]+:.*\n)*?\s+default: '${release}'`,
      'g',
    ),
  ],
];

describe('Node runtime pins', () => {
  it('has exactly one base image release', () => {
    expect(base).toHaveLength(1);
  });

  it.each(copies)('%s matches the node base image', (file, pattern) => {
    const found = versions(file, pattern);
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set(base));
  });

  it('lets Renovate move every non-FROM copy in the Node group', () => {
    const config = JSON.parse(read('renovate.json')) as {
      customManagers: {
        depNameTemplate?: string;
        managerFilePatterns: string[];
      }[];
    };
    const patterns = config.customManagers
      .filter((manager) => manager.depNameTemplate === 'node')
      .flatMap((manager) => manager.managerFilePatterns)
      .map((pattern) => new RegExp(pattern.slice(1, -1)));
    const regexCopies = copies
      .filter(
        ([, pattern]) =>
          !pattern.source.startsWith('^FROM ') &&
          !pattern.source.includes('NODE_BUILD_BASE'),
      )
      .map(([file]) => file);
    for (const file of regexCopies) {
      expect(
        patterns.some((pattern) => pattern.test(file)),
        file,
      ).toBe(true);
    }
  });
});
