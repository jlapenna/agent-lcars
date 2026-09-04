import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { logger } from '@agent-lcars/logging';
import { initNodeLogging } from '@agent-lcars/logging/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The control-plane ingestion path: every module whose logs are read to
 *  answer "did this delivery arrive, and why did it fail".
 *
 *  Resolved against this file rather than the working directory: CI runs
 *  this project's vitest with its cwd at `apps/console`, so repo-relative
 *  paths silently resolve to nothing there while passing from the repo root.
 */
const INGESTION_MODULES = [
  '../app/api/control-plane/webhook/route.ts',
  '../app/api/control-plane/webhook/process/route.ts',
  '../app/api/control-plane/reconcile/route.ts',
  './orchestrator-routes.ts',
  './push-watch.ts',
];

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

  it('routes every control-plane ingestion log through the shared logger', async () => {
    const offenders: string[] = [];
    for (const path of INGESTION_MODULES) {
      const source = await readFile(
        fileURLToPath(new URL(path, import.meta.url)),
        'utf8',
      );
      const bare = source.match(/\bconsole\.(error|warn|info|log|debug)\(/g);
      if (bare) offenders.push(`${path}: ${bare.join(', ')}`);
    }

    // A bare console call here is invisible to the structured-entry contract
    // above, so it silently reintroduces the split-entry problem.
    expect(offenders).toEqual([]);
  });
});
