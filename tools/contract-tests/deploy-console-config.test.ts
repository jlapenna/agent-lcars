import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
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
  assertBackendContract,
  buildIdFor,
  createArchive,
  loadAppHostingConfig,
  makeBuildBody,
  prepareBuildEnv,
  rolloutVerdict,
} from '../deploy-console-prebuilt.mjs';

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(import.meta.dirname, '../..');

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe('console deployment workflow', () => {
  it('searches the newest App Hosting builds for the deployed archive', async () => {
    const workflow = await readFile(
      '.github/workflows/deploy-console.yml',
      'utf8',
    );

    expect(workflow).toContain(
      'builds?pageSize=100&orderBy=create_time%20desc',
    );
    expect(workflow).toContain(
      'select(.source.archive.userStorageUri == env.MANAGED_SOURCE_URI)',
    );
  });

  it('uses the cache-enabled CI pool for local builds with a managed fallback', async () => {
    const workflow = await readFile(
      '.github/workflows/deploy-console.yml',
      'utf8',
    );

    expect(workflow).toContain("runs-on: ['${{ vars.CI_RUNNER_LABEL }}']");
    expect(workflow).toContain('./.github/actions/setup-nx-remote-cache');
    expect(workflow).toContain('node tools/deploy-console-prebuilt.mjs');
    expect(workflow).toContain("if: inputs.build_mode == 'managed'");
  });

  it('translates the App Hosting YAML into a local build contract', async () => {
    const config = await loadAppHostingConfig(
      'apps/console/apphosting.yaml',
      '611425338852',
    );

    expect(config.outputFiles).toEqual([
      'dist/apps/console/.next/standalone',
      'dist/apps/console/.next/static',
    ]);
    expect(config.runConfig).toEqual({
      cpu: 1,
      memoryMib: 1024,
      minInstances: 0,
    });
    expect(config.buildEnv).toEqual({ PROJECT_ID: 'agent-lcars' });
    expect(config.env).toContainEqual({
      variable: 'AUTH_SECRET',
      secret: 'projects/611425338852/secrets/AUTH_SECRET/versions/latest',
      availability: ['RUNTIME'],
    });

    const buildEnv = prepareBuildEnv(config, {
      PATH: '/runner/bin',
      CLOUD_BUILD: 'true',
      AUTH_SECRET: 'must-not-leak',
    });
    expect(buildEnv).toMatchObject({
      PATH: '/runner/bin',
      PROJECT_ID: 'agent-lcars',
    });
    expect(buildEnv).not.toHaveProperty('CLOUD_BUILD');
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
    const artifact = `gs://sources/prebuilt/${buildId}.tar.gz`;
    const body = makeBuildBody(config, artifact, 'apps/console', commit);

    expect(buildId).toMatch(/^pb-a{12}-[0-9a-f]{12}$/u);
    expect(buildId.length).toBeLessThanOrEqual(30);
    expect(body.source.locallyBuilt).toMatchObject({
      userStorageUri: artifact,
      rootDirectory: 'apps/console',
      runCommand: 'node server.js',
    });
    expect(body.labels['commit-sha']).toBe(commit);
  });

  it('fails closed on an unexpected App Hosting runtime contract', () => {
    expect(() =>
      assertBackendContract(
        {
          runtime: { value: 'nodejs24' },
          automaticBaseImageUpdatesDisabled: false,
        },
        'nodejs24',
      ),
    ).not.toThrow();
    expect(() =>
      assertBackendContract({ runtime: { value: 'nodejs22' } }, 'nodejs24'),
    ).toThrow(/nodejs22.*nodejs24/u);
    expect(() =>
      assertBackendContract(
        {
          runtime: { value: 'nodejs24' },
          automaticBaseImageUpdatesDisabled: true,
        },
        'nodejs24',
      ),
    ).toThrow(/automatic base image updates disabled/u);
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
    const artifact = 'gs://sources/prebuilt/pb-test.tar.gz';
    const commit = 'b'.repeat(40);
    const [verdict] = rolloutVerdict({
      build: {
        name: buildName,
        state: 'READY',
        image: 'us-docker.pkg.dev/image',
        labels: { 'commit-sha': commit },
        source: { locallyBuilt: { userStorageUri: artifact } },
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

  it('keeps Nx caching enabled for the managed App Hosting build', async () => {
    const config = parseYaml(
      await readFile('apps/console/apphosting.yaml', 'utf8'),
    ) as {
      scripts?: { buildCommand?: string };
      env?: Array<{ variable?: string }>;
    };

    expect(config.scripts?.buildCommand).toBe(
      '. tools/cloud-build-prebuild.sh && ./tools/nx bundle @agent-lcars/console --verbose',
    );
    expect(config.scripts?.buildCommand).not.toMatch(/skip.*cache/iu);
    expect(config.env?.map(({ variable }) => variable)).not.toContain(
      'NX_SKIP_NX_CACHE',
    );
  });

  it('cleans stale Cloud Build outputs without erasing the local Nx cache', async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-lcars-cloud-build-prebuild-'),
    );
    const stalePaths = [
      'dist/apps/console/stale-output',
      'apps/console/dist/stale-output',
      'libs/util/dist/stale-output',
      'libs/util/stale.tsbuildinfo',
    ];
    const cacheEntry = path.join(fixtureRoot, '.nx/cache/cache-entry');

    try {
      for (const relativePath of stalePaths) {
        const filePath = path.join(fixtureRoot, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'stale');
      }
      await mkdir(path.dirname(cacheEntry), { recursive: true });
      await writeFile(cacheEntry, 'content-addressed-cache-entry');

      await execFileAsync(
        'bash',
        [path.join(workspaceRoot, 'tools/cloud-build-prebuild.sh')],
        {
          cwd: fixtureRoot,
          env: { ...process.env, CLOUD_BUILD: 'true' },
        },
      );

      await expect(readFile(cacheEntry, 'utf8')).resolves.toBe(
        'content-addressed-cache-entry',
      );
      await expect(
        Promise.all(
          stalePaths.map((stalePath) =>
            exists(path.join(fixtureRoot, stalePath)),
          ),
        ),
      ).resolves.toEqual(stalePaths.map(() => false));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
