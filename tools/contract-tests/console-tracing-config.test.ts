import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const consoleRoot = path.join(workspaceRoot, 'apps/console');
const virtualStore = path.join(workspaceRoot, 'node_modules/.pnpm');
// Loading the production Next config also loads Nx's plugin graph. That real
// integration can exceed Vitest's 5s default on a cold runner (#1529).
const coldConfigLoadTimeoutMs = 30_000;
let staleVariant = '';

afterEach(async () => {
  if (staleVariant) {
    await rm(staleVariant, { recursive: true, force: true });
    staleVariant = '';
  }
});

describe('console output-file tracing', () => {
  it(
    'ignores an unused physical Cloud Tasks peer variant',
    async () => {
      staleVariant = await mkdtemp(
        path.join(virtualStore, '@google-cloud+tasks@0.0.0_stale-peer-'),
      );
      const staleProto = path.join(
        staleVariant,
        'node_modules/@google-cloud/tasks/build/protos/protos.json',
      );
      await mkdir(path.dirname(staleProto), { recursive: true });
      // The production failure only needs a physical stale peer asset. Walking
      // the whole pnpm virtual store merely proves the fixture exists and makes
      // this contract I/O-bound on cold CI runners (#1529).
      await writeFile(staleProto, '{}');
      const staleProtoInclude = path
        .relative(consoleRoot, staleProto)
        .split(path.sep)
        .join('/');

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
      expect(tracedIncludes?.[0]).not.toBe(staleProtoInclude);
      await expect(
        access(path.resolve(consoleRoot, tracedIncludes![0])),
      ).resolves.toBeUndefined();
    },
    coldConfigLoadTimeoutMs,
  );
});
