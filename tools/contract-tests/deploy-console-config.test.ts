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
  it('caches each top-level console build artifact without overlapping outputs', async () => {
    const project = JSON.parse(
      await readFile('apps/console/project.json', 'utf8'),
    ) as {
      targets: { build: { outputs: string[] } };
    };

    // Nx expands this one-level glob to sibling roots, including hidden
    // `.next` and `.nx-helpers` directories. Declaring the output root beside
    // either child makes cache restore remove/copy overlapping paths in
    // parallel, which can leave the deployable `.next/static` tree hollow.
    expect(project.targets.build.outputs).toEqual(['{options.outputPath}/*']);
  });

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

  it('uses managed builds by default and keeps prebuilt deployment opt-in', async () => {
    const workflow = await readFile(
      '.github/workflows/deploy-console.yml',
      'utf8',
    );

    expect(workflow).toContain("runs-on: ['lcars-ci']");
    expect(workflow).toContain('default: managed');
    expect(workflow).toContain('./.github/actions/setup-nx-remote-cache');
    expect(workflow).toContain('node tools/deploy-console-prebuilt.mjs');
    expect(workflow).toContain("if: inputs.build_mode == 'prebuilt'");
    expect(workflow).toContain("if: inputs.build_mode != 'prebuilt'");
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

  it('waits for build registration before validating or starting a rollout', async () => {
    const deployTool = await readFile(
      'tools/deploy-console-prebuilt.mjs',
      'utf8',
    );
    const buildWait = deployTool.indexOf(
      'await waitForOperation(buildOperation)',
    );
    const rolloutValidation = deployTool.indexOf("validateOnly: 'true'");
    const rolloutStart = deployTool.indexOf(
      'console.log(`[Deploy] Starting rollout',
    );

    expect(buildWait).toBeGreaterThan(-1);
    expect(buildWait).toBeLessThan(rolloutValidation);
    expect(buildWait).toBeLessThan(rolloutStart);
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

  it('keeps every deployed Work grant explicitly scoped', async () => {
    const config = parseYaml(
      await readFile('apps/console/apphosting.yaml', 'utf8'),
    ) as {
      env?: Array<{ variable?: string; value?: string }>;
    };
    const grantsValue = config.env?.find(
      ({ variable }) => variable === 'AGENT_LCARS_WORK_GRANTS',
    )?.value;

    expect(grantsValue).toBeDefined();
    const grants = JSON.parse(grantsValue ?? '[]') as Array<{
      principal: string;
      pipelines: string[];
      scopes?: string[];
    }>;
    const workflowGrant = grants.find(
      ({ principal }) => principal === 'workflow:work-create',
    );

    // work-create.yml exposes PIPELINE as its native Work API pipeline
    // choice. Keep its admission grant in sync with the provider canaries
    // and fail closed if an old implicit operator scope reappears.
    expect(workflowGrant).toMatchObject({
      principal: 'workflow:work-create',
      pipelines: ['claude', 'codex', 'opencode'],
      scopes: ['work.operator'],
    });
    expect(
      grants.find(
        ({ principal }) => principal === 'workflow:member-automation',
      ),
    ).toMatchObject({
      principal: 'workflow:member-automation',
      pipelines: ['claude', 'codex', 'opencode'],
      scopes: ['work.operator'],
    });
    expect(
      grants.find(({ principal }) => principal === 'svc:telemetry-writer'),
    ).toMatchObject({
      principal: 'svc:telemetry-writer',
      pipelines: ['claude', 'codex', 'opencode'],
      // The same Google principal drives both the durable executor and the
      // server-owned schedule ticker. Pin this deployed grant so the ticker
      // cannot silently start returning work.cron 401s after a config edit.
      scopes: ['work.executor', 'work.cron'],
    });
    expect(
      config.env?.find(
        ({ variable }) => variable === 'AGENT_LCARS_WORK_AUDIENCE',
      )?.value,
    ).toBe('agent-lcars-work');
    for (const grant of grants) {
      expect(grant.scopes).toEqual(expect.any(Array));
      expect(grant.scopes).not.toHaveLength(0);
    }
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
