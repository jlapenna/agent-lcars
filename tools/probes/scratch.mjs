// Probe scratch lifecycle: one temporary root per run, removed at exit.
//
// Native probes copy provider homes, dependencies, and workspaces into their
// scratch root, so a retained root can be gigabytes. Nothing else deletes
// them (homelab#1542), so each probe owns its own cleanup: a passing run
// removes its root, while a failing run (nonzero exit, uncaught exception)
// keeps it as diagnostic evidence and says where. Set
// LCARS_PROBE_KEEP_EVIDENCE=1 to keep a passing run's root too, e.g. when a
// later release-qualification step consumes its observations.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KEEP_EVIDENCE_ENV = 'LCARS_PROBE_KEEP_EVIDENCE';

/** Whether a probe that exits with `code` keeps its scratch root. */
export function retainsScratch(code, env = process.env) {
  return code !== 0 || env[KEEP_EVIDENCE_ENV] === '1';
}

/** Removes or reports `root` according to {@link retainsScratch}. Never
 *  throws: cleanup must not turn a passing probe into a failing one. */
export function settleScratch(root, code, env = process.env) {
  if (retainsScratch(code, env)) {
    process.stderr.write(`probe evidence retained at ${root}\n`);
    return 'retained';
  }
  try {
    rmSync(root, { recursive: true, force: true });
    return 'removed';
  } catch (error) {
    process.stderr.write(
      `probe scratch cleanup failed for ${root}: ${error?.message ?? error}\n`,
    );
    return 'failed';
  }
}

/** Creates a scratch root under the system temp directory and settles it
 *  when the process exits, however the probe finishes. */
export function createProbeScratch(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.once('exit', (code) => settleScratch(root, code));
  return root;
}
