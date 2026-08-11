import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseChangedFiles, planImageBuilds } from './plan.mjs';

function env(name) {
  return process.env[name] ?? '';
}

function output(name, value) {
  const path = env('GITHUB_OUTPUT');
  return fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

// No well-defined prior state to diff against: workflow_dispatch (an
// explicit manual "republish everything" request -- see this action's own
// action.yml for why base-ref is deliberately left empty for that trigger)
// or a push whose `before` SHA is the all-zero placeholder / otherwise
// unreachable (a rewritten or newly created ref). `planImageBuilds(null)`
// is the tested safe default for all of these: build everything rather
// than silently building nothing.
function isDiffable(baseRef) {
  return baseRef !== '' && !/^0+$/u.test(baseRef);
}

function changedFilesBetween(baseRef, headRef) {
  if (!isDiffable(baseRef)) {
    return { changedFiles: null, reason: 'no diffable base ref' };
  }
  try {
    const diffOutput = execFileSync(
      'git',
      ['diff', '--name-only', `${baseRef}`, `${headRef}`],
      { encoding: 'utf8' },
    );
    return {
      changedFiles: parseChangedFiles(diffOutput),
      reason: `diffed ${baseRef}..${headRef}`,
    };
  } catch (error) {
    console.log(
      `::warning::plan-image-publish: git diff ${baseRef}..${headRef} ` +
        `failed (${error.message}); defaulting to a full publish.`,
    );
    return { changedFiles: null, reason: 'git diff failed' };
  }
}

async function run() {
  const { changedFiles, reason } = changedFilesBetween(
    env('BASE_REF'),
    env('HEAD_REF'),
  );
  const plan = planImageBuilds(changedFiles);
  console.log(
    `::notice::plan-image-publish (${reason}, ` +
      `${changedFiles === null ? 'unknown' : changedFiles.length} changed ` +
      `file(s)): control-plane=${plan.controlPlane} ` +
      `jit-runner=${plan.jitRunner} watcher=${plan.watcher} ` +
      `exporter=${plan.exporter} e2e=${plan.e2e} ` +
      `e2e-runner=${plan.e2eRunner}`,
  );
  await output('control-plane', String(plan.controlPlane));
  await output('jit-runner', String(plan.jitRunner));
  await output('watcher', String(plan.watcher));
  await output('exporter', String(plan.exporter));
  await output('e2e', String(plan.e2e));
  await output('e2e-runner', String(plan.e2eRunner));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}

export { changedFilesBetween, isDiffable };
