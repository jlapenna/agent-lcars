import assert from 'node:assert/strict';

import { parseChangedFiles, planImageBuilds } from './plan.mjs';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('no changed files plans no image builds', () => {
  assert.deepEqual(planImageBuilds([]), {
    controlPlane: false,
    jitRunner: false,
    watcher: false,
  });
});

// agent-lcars#441 acceptance criterion: a shared telemetry source or
// dependency change schedules both the JIT runner and watcher builds.
test('a shared telemetry lib change schedules both the JIT runner and watcher, not the control plane', () => {
  assert.deepEqual(planImageBuilds(['libs/telemetry/src/lib/reducer.ts']), {
    controlPlane: false,
    jitRunner: true,
    watcher: true,
  });
});

test('every shared-telemetry input schedules both the JIT runner and watcher', () => {
  for (const file of [
    'libs/telemetry/src/index.ts',
    'libs/logging/src/index.ts',
    'libs/env-vars/src/index.ts',
    'libs/util/src/index.ts',
    'libs/util-server/src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    'patches/@nx__next.patch',
  ]) {
    const plan = planImageBuilds([file]);
    assert.equal(
      plan.jitRunner,
      true,
      `${file} should schedule the JIT runner`,
    );
    assert.equal(plan.watcher, true, `${file} should schedule the watcher`);
    assert.equal(
      plan.controlPlane,
      false,
      `${file} should not schedule the control plane`,
    );
  }
});

// agent-lcars#441 acceptance criterion: a watcher-only source change
// schedules the watcher build without unrelated control-plane work.
test('a watcher-only source change schedules only the watcher', () => {
  assert.deepEqual(
    planImageBuilds(['apps/telemetry-watcher/src/lib/daemon.ts']),
    { controlPlane: false, jitRunner: false, watcher: true },
  );
});

// agent-lcars#441 acceptance criterion: a watcher deployment-config-only or
// documentation-only change schedules no image build where safe. Concrete
// regression case: agent-lcars#440 changed exactly these two files and
// triggered a full, wasted publish run (agent-lcars#441 issue comment).
test('a watcher deployment-config-only change schedules no image build (regression for #440)', () => {
  assert.deepEqual(
    planImageBuilds([
      'apps/telemetry-watcher/deploy/docker-compose.yml',
      'apps/telemetry-watcher/deploy/README.md',
    ]),
    { controlPlane: false, jitRunner: false, watcher: false },
  );
});

test('a watcher documentation-only change schedules no image build', () => {
  assert.deepEqual(planImageBuilds(['apps/telemetry-watcher/README.md']), {
    controlPlane: false,
    jitRunner: false,
    watcher: false,
  });
});

// agent-lcars#441 acceptance criterion: a control-plane-only change does
// not rebuild the JIT runner or watcher.
test('a control-plane-only change schedules only the control plane', () => {
  assert.deepEqual(planImageBuilds(['apps/runner-autoscaler/scaler.go']), {
    controlPlane: true,
    jitRunner: false,
    watcher: false,
  });
});

test('runner-image inputs schedule the JIT runner, not the control plane', () => {
  assert.deepEqual(
    planImageBuilds([
      'apps/runner-autoscaler/runner-image/Dockerfile',
      'apps/runner-autoscaler/runner-image/entrypoint.sh',
    ]),
    { controlPlane: false, jitRunner: true, watcher: false },
  );
});

test('a mixed push schedules exactly the images its changes touch', () => {
  assert.deepEqual(
    planImageBuilds([
      'apps/runner-autoscaler/scaler.go',
      'apps/telemetry-watcher/deploy/docker-compose.yml',
    ]),
    { controlPlane: true, jitRunner: false, watcher: false },
  );
});

// Changing how images are built/scanned/promoted is as much a reason to
// rebuild everything as changing what's in them (mirrors the existing
// scan-image rationale in publish-images.yml, agent-lcars#224).
test('a publish-images.yml or scan-image change schedules every image', () => {
  for (const file of [
    '.github/workflows/publish-images.yml',
    '.github/actions/scan-image/action.yml',
    '.github/actions/plan-image-publish/plan.mjs',
  ]) {
    assert.deepEqual(
      planImageBuilds([file]),
      { controlPlane: true, jitRunner: true, watcher: true },
      `${file} should schedule every image`,
    );
  }
});

test('an unrelated change (e.g. the console app) schedules no image build', () => {
  assert.deepEqual(
    planImageBuilds(['apps/console/src/app/page.tsx', 'docs/incidents.md']),
    { controlPlane: false, jitRunner: false, watcher: false },
  );
});

// The explicit "no well-defined diff" sentinel: a manual workflow_dispatch
// republish, or a push whose prior state can't be diffed. Must default to
// building everything rather than silently building nothing.
test('the null sentinel (no diffable base) plans every image', () => {
  assert.deepEqual(planImageBuilds(null), {
    controlPlane: true,
    jitRunner: true,
    watcher: true,
  });
});

test('parseChangedFiles splits git diff --name-only output and drops blank lines', () => {
  assert.deepEqual(
    parseChangedFiles('apps/console/src/app/page.tsx\n\npackage.json\n'),
    ['apps/console/src/app/page.tsx', 'package.json'],
  );
  assert.deepEqual(parseChangedFiles(''), []);
  assert.deepEqual(parseChangedFiles('\n\n'), []);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failures > 0) process.exitCode = 1;
