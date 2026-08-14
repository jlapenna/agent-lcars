import { globSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const consoleRoot = path.join(workspaceRoot, 'apps/console');
const virtualStore = path.join(workspaceRoot, 'node_modules/.pnpm');
const legacyProtoGlob =
  '../../node_modules/.pnpm/@google-cloud+tasks@*/node_modules/@google-cloud/tasks/build/protos/protos.json';

let staleVariant = '';

afterEach(async () => {
  if (staleVariant) {
    await rm(staleVariant, { recursive: true, force: true });
    staleVariant = '';
  }
});

describe('console output-file tracing', () => {
  it('ignores an unused physical Cloud Tasks peer variant', async () => {
    const installedMatches = globSync(legacyProtoGlob, { cwd: consoleRoot });
    expect(installedMatches.length).toBeGreaterThan(0);

    staleVariant = await mkdtemp(
      path.join(virtualStore, '@google-cloud+tasks@0.0.0_stale-peer-'),
    );
    const staleProto = path.join(
      staleVariant,
      'node_modules/@google-cloud/tasks/build/protos/protos.json',
    );
    await mkdir(path.dirname(staleProto), { recursive: true });
    await copyFile(
      path.join(
        workspaceRoot,
        'node_modules/@google-cloud/tasks/build/protos/protos.json',
      ),
      staleProto,
    );

    const poisonedMatches = globSync(legacyProtoGlob, { cwd: consoleRoot });
    expect(poisonedMatches).toHaveLength(installedMatches.length + 1);
    expect(poisonedMatches).toContain(
      path.relative(consoleRoot, staleProto).split(path.sep).join('/'),
    );

    // next.config.js deliberately exports the CommonJS function Next loads.
    // eslint-disable-next-line no-restricted-syntax
    const exportedConfig = require(
      path.join(consoleRoot, 'next.config.js'),
    ) as (
      phase: string,
      context: { defaultConfig: Record<string, never> },
    ) => Promise<{
      outputFileTracingIncludes?: Record<string, string[]>;
    }>;
    const config = await exportedConfig('phase-production-build', {
      defaultConfig: {},
    });
    const tracedIncludes =
      config.outputFileTracingIncludes?.['/api/control-plane/webhook*'];

    expect(tracedIncludes).toHaveLength(1);
    expect(tracedIncludes?.[0]).not.toContain('*');
    expect(globSync(tracedIncludes![0], { cwd: consoleRoot })).toEqual([
      tracedIncludes![0],
    ]);
  });
});
