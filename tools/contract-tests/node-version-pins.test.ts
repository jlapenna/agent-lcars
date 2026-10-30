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

  it('lets Renovate extract every non-FROM copy at the same release', () => {
    const config = JSON.parse(read('renovate.json')) as {
      customManagers: {
        depNameTemplate?: string;
        managerFilePatterns: string[];
        matchStrings: string[];
      }[];
    };
    const managers = config.customManagers.filter(
      (manager) => manager.depNameTemplate === 'node',
    );
    const regexCopies = [
      ...new Set(
        copies
          .filter(
            ([, pattern]) =>
              !pattern.source.startsWith('^FROM ') &&
              !pattern.source.includes('NODE_BUILD_BASE'),
          )
          .map(([file]) => file),
      ),
    ];
    for (const file of regexCopies) {
      const text = read(file);
      const extracted = managers
        .filter((manager) =>
          manager.managerFilePatterns.some((pattern) =>
            new RegExp(pattern.slice(1, -1)).test(file),
          ),
        )
        .flatMap((manager) =>
          manager.matchStrings.flatMap((matchString) =>
            [...text.matchAll(new RegExp(matchString, 'g'))].map(
              (match) => match.groups?.['currentValue'],
            ),
          ),
        );
      expect(extracted.length, file).toBeGreaterThan(0);
      expect(new Set(extracted), file).toEqual(new Set(base));
    }
  });

  it('runs the console on a distroless image of the pinned major', () => {
    // Distroless names its image by Node major and floats the patch, so
    // Renovate moves only its digest. #3104 moved every other pin to Node 26
    // while production kept running 24.22.1 on nodejs24-debian13.
    const builder = read('tools/build-console-container.mjs');
    const majors = [
      ...builder.matchAll(
        /gcr\.io\/distroless\/nodejs(\d+)-debian\d+@sha256:/g,
      ),
    ].map((match) => match[1]);
    expect(majors).toHaveLength(1);
    expect(majors).toEqual(base.map((version) => version.split('.')[0]));
    const config = JSON.parse(read('renovate.json')) as {
      customManagers: {
        managerFilePatterns: string[];
        matchStrings: string[];
      }[];
    };
    const digests = config.customManagers
      .filter((manager) =>
        manager.managerFilePatterns.some((pattern) =>
          new RegExp(pattern.slice(1, -1)).test(
            'tools/build-console-container.mjs',
          ),
        ),
      )
      .flatMap((manager) =>
        manager.matchStrings.flatMap((matchString) =>
          [...builder.matchAll(new RegExp(matchString, 'g'))].map(
            (match) => match.groups?.['currentDigest'],
          ),
        ),
      );
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('installs NodeSource from the channel of the pinned major', () => {
    // A hard-coded node_<major>.x channel lets a major bump pass every pin
    // check and then fail apt-get install at publication.
    const dockerfile = read('apps/runner-autoscaler/runner-image/Dockerfile');
    expect(dockerfile).toContain(
      'https://deb.nodesource.com/node_${NODE_VERSION%%.*}.x nodistro main',
    );
    expect(dockerfile).not.toMatch(/deb\.nodesource\.com\/node_\d+\.x/);
  });
});
