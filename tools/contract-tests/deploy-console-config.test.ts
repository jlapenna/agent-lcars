import { execFile } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  buildIdFor,
  createArchive,
  loadAppHostingConfig,
  makeBuildBody,
  prepareBuildEnv,
  rolloutVerdict,
} from '../deploy-console-prebuilt.mjs';

const execFileAsync = promisify(execFile);

describe('console deployment workflow', () => {
  it('translates the App Hosting YAML into a local build contract', async () => {
    const config = await loadAppHostingConfig(
      'apps/console/apphosting.yaml',
      '611425338852',
    );

    const buildEnv = prepareBuildEnv(config, {
      PATH: '/runner/bin',
      AUTH_SECRET: 'must-not-leak',
    });
    expect(buildEnv).toMatchObject({
      PATH: '/runner/bin',
      PROJECT_ID: 'agent-lcars',
    });
    expect(buildEnv).not.toHaveProperty('CI');
    expect(buildEnv).not.toHaveProperty('AUTH_SECRET');
  });

  it('creates attributable, rerun-safe prebuilt build resources', () => {
    const commit = 'a'.repeat(40);
    const buildId = buildIdFor(commit, '12345', '2');
    const config = {
      runCommand: 'node server.js',
      runConfig: { cpu: 1 },
      env: [],
    };
    const artifact = `us-central1-docker.pkg.dev/agent-lcars/firebaseapphosting-images/console@sha256:${'1'.repeat(64)}`;
    const body = makeBuildBody(config, artifact, commit);

    expect(buildId).toMatch(/^pb-a{12}-[0-9a-f]{12}$/u);
    expect(buildId.length).toBeLessThanOrEqual(30);
    expect(body.source).toEqual({ container: { image: artifact } });
    expect(body.labels['commit-sha']).toBe(commit);
  });

  it.each([
    'gs://sources/source.tar.gz',
    'us-central1-docker.pkg.dev/agent-lcars/firebaseapphosting-images/console:latest',
    'docker.io/example/console@sha256:' + '1'.repeat(64),
  ])('rejects a source requiring a build or mutable image: %s', (image) => {
    expect(() =>
      makeBuildBody({ runConfig: { cpu: 1 }, env: [] }, image, 'a'.repeat(40)),
    ).toThrow(/immutable Artifact Registry/u);
  });

  it('materializes pnpm hardlinks as ordinary archive files', async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-lcars-prebuilt-archive-'),
    );
    const extractedRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-lcars-prebuilt-extracted-'),
    );
    let archiveDirectory: string | undefined;
    try {
      const outputRoot = path.join(fixtureRoot, 'dist/apps/console');
      await mkdir(outputRoot, { recursive: true });
      await writeFile(path.join(outputRoot, 'first.js'), 'artifact');
      await link(
        path.join(outputRoot, 'first.js'),
        path.join(outputRoot, 'second.js'),
      );

      const archive = await createArchive(
        fixtureRoot,
        ['dist/apps/console'],
        'pb-test',
      );
      archiveDirectory = archive.tempDirectory;
      await execFileAsync('tar', [
        '--extract',
        '--gzip',
        '--file',
        archive.archivePath,
        '--directory',
        extractedRoot,
      ]);

      const [first, second] = await Promise.all([
        lstat(path.join(extractedRoot, 'dist/apps/console/first.js')),
        lstat(path.join(extractedRoot, 'dist/apps/console/second.js')),
      ]);
      expect(first.ino).not.toBe(second.ino);
      await expect(
        readFile(
          path.join(extractedRoot, 'dist/apps/console/second.js'),
          'utf8',
        ),
      ).resolves.toBe('artifact');
    } finally {
      await Promise.all([
        rm(fixtureRoot, { recursive: true, force: true }),
        rm(extractedRoot, { recursive: true, force: true }),
        archiveDirectory
          ? rm(archiveDirectory, { recursive: true, force: true })
          : Promise.resolve(),
      ]);
    }
  });

  it('requires the exact prebuilt build to own all production traffic', () => {
    const buildName =
      'projects/agent-lcars/locations/us-central1/backends/agent-lcars/builds/pb-test';
    const artifact = `us-central1-docker.pkg.dev/agent-lcars/firebaseapphosting-images/console@sha256:${'1'.repeat(64)}`;
    const commit = 'b'.repeat(40);
    const [verdict] = rolloutVerdict({
      build: {
        name: buildName,
        state: 'READY',
        image: 'us-docker.pkg.dev/image',
        labels: { 'commit-sha': commit },
        source: { container: { image: artifact } },
      },
      rollout: {
        build: buildName,
        state: 'SUCCEEDED',
      },
      traffic: {
        current: { splits: [{ build: buildName, percent: 100 }] },
      },
      expectedBuildName: buildName,
      expectedCommit: commit,
      expectedArtifact: artifact,
    });

    expect(verdict).toBe('success');
  });

  it('declares a non-empty value or a secret for every deployed env entry', async () => {
    // App Hosting's preparer rejects an entry carrying neither with
    // `either 'value' or 'secret' field is required`, and an empty string
    // counts as neither. #1773 shipped `value: ''` and broke every console
    // deploy for five hours while the test above -- which asserted exactly
    // that empty string -- stayed green. This is the invariant that check
    // should have been.
    const config = parseYaml(
      await readFile('apps/console/apphosting.yaml', 'utf8'),
    ) as {
      env?: Array<{ variable?: string; value?: unknown; secret?: unknown }>;
    };

    const invalid = (config.env ?? []).filter(
      ({ value, secret }) =>
        !(typeof secret === 'string' && secret !== '') &&
        !(value !== undefined && value !== null && String(value) !== ''),
    );

    expect(invalid.map(({ variable }) => variable)).toEqual([]);
  });
});
