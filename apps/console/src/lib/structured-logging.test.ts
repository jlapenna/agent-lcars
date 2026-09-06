import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '@agent-lcars/logging';
import { initNodeLogging } from '@agent-lcars/logging/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `apps/console/src`, resolved from the working directory rather than
 *  `import.meta.url`: this project runs under jsdom, where `node:url` is
 *  aliased to a browser shim whose `fileURLToPath` rejects the file URL.
 *  CI runs vitest with its cwd at `apps/console` and local runs use the
 *  repo root, so both are tried -- and if neither exists this throws rather
 *  than returning nothing, since a guard that silently scans an empty tree
 *  passes for the wrong reason. */
async function consoleSourceRoot(): Promise<string> {
  for (const candidate of ['apps/console/src', 'src']) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `cannot locate apps/console/src from ${process.cwd()}; the sweep guard would scan nothing`,
  );
}

/** Every server-side source file under `apps/console/src`.
 *
 *  Enumerated by walking the tree rather than listing modules, so a new
 *  server file is covered the moment it exists. #1779 shipped a hardcoded
 *  five-module list; anything added beside it was silently unguarded. */
async function serverSourceFiles(): Promise<string[]> {
  const root = await consoleSourceRoot();
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      const source = await readFile(full, 'utf8');
      // A 'use client' module logs to the browser console, where Cloud
      // Logging's per-line splitting does not apply -- and routing one
      // through the server logger is the RSC boundary trap that neither
      // unit tests nor typecheck catch (#1049 has E2E paused). It stays on
      // console.* deliberately.
      if (/^\s*['"]use client['"]/m.test(source.slice(0, 400))) continue;
      found.push(full);
    }
  };
  await walk(root);
  return found;
}

describe('control-plane structured logging', () => {
  beforeEach(() => {
    process.env['FORCE_STRUCTURED_LOGGING'] = 'true';
    // Mirror production: `instrumentation.ts` installs this formatter on
    // boot. It matters here rather than being incidental setup -- the
    // default formatter renders an Error as `error.stack`, and a stack does
    // NOT include the `[cause]` chain. Without it the cause is dropped
    // before it ever reaches Cloud Logging.
    initNodeLogging();
  });

  afterEach(() => {
    delete process.env['FORCE_STRUCTURED_LOGGING'];
    vi.restoreAllMocks();
  });

  // Cloud Logging creates one entry per *line* of output. A bare
  // `console.error(msg, err)` prints the message, the stack, and the
  // `[cause]` chain across many lines, so each lands as its own entry and no
  // single query can match a string from two different lines. That is not
  // cosmetic: it produced three wrong conclusions during the #1762/#1767
  // investigation, including "no push deliveries have ever arrived" (they
  // had) and "the error logs no cause" (it did, one entry below).
  it('emits one line per log call, with the cause chain intact', () => {
    const written: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      written.push(...args);
    });

    logger.error(
      'agent-lcars: retaining projection-only webhook repair',
      new Error('Projection refresh failed for check_run/abc123', {
        cause: new Error('could not apply after 6 fenced attempts'),
      }),
    );

    expect(written).toHaveLength(1);
    const line = written[0] as string;
    expect(line).not.toContain('\n');

    const entry = JSON.parse(line) as { severity: string; message: string };
    expect(entry.severity).toBe('ERROR');
    // Both the wrapper and its cause are reachable from the same entry, so
    // one query answers "why did this delivery fail".
    expect(entry.message).toContain('retaining projection-only webhook repair');
    expect(entry.message).toContain('could not apply after 6 fenced attempts');
  });

  it('routes every server-side log through the shared logger', async () => {
    const offenders: string[] = [];
    for (const path of await serverSourceFiles()) {
      const source = await readFile(path, 'utf8');
      const bare = source.match(/\bconsole\.(error|warn|info|log|debug)\(/g);
      if (bare) {
        offenders.push(`${path.split('/console/')[1]}: ${bare.join(', ')}`);
      }
    }

    // A bare console call here is invisible to the structured-entry contract
    // above, so it silently reintroduces the split-entry problem.
    expect(offenders).toEqual([]);
  });

  it('leaves client components on console.*, where splitting does not apply', async () => {
    // Guards the exclusion itself: if error.tsx ever loses its 'use client'
    // directive the sweep above would start demanding the server logger in
    // a browser component, which is the RSC trap, not a fix.
    const source = await readFile(
      join(await consoleSourceRoot(), 'app/error.tsx'),
      'utf8',
    );
    expect(source.slice(0, 400)).toMatch(/^\s*['"]use client['"]/m);
    expect(source).toMatch(/\bconsole\.(error|warn|info|log)\(/);
  });
});
