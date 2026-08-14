import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
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
      'select(.source.archive.userStorageUri == env.SOURCE_URI)',
    );
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
