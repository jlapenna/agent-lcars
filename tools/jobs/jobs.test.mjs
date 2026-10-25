import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { discover } from './catalog.mjs';
import { JobController } from './controller.mjs';
import { admitProfile, definition, dueAt } from './definition.mjs';
import { cgroupAllocation, gooseExecutor } from './goose.mjs';

const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
const profile = {
  name: 'audit',
  capacity: allocation,
  repositories: ['example/repo'],
  subnets: ['192.0.2.0/24'],
  findingsRepositories: ['example/repo'],
};
const job = {
  version: 1,
  description: 'Reference security assessment',
  triggers: {
    manual: true,
    schedule: { cron: '0 6 * * 0', timezone: 'America/Los_Angeles' },
  },
  execution: {
    recipe: './recipe.yaml',
    profile: 'audit',
    timeout: '30m',
    maxAttempts: 1,
    resources: { requests: allocation, limits: allocation },
  },
  inputs: {
    subnet: '192.0.2.0/24',
    findingsRepository: 'example/repo',
    mode: 'report',
  },
  concurrency: { maxRuns: 1, overlap: 'skip' },
  state: { previousSuccessfulResult: true },
  result: {
    contract: 'security-audit-v1',
    requiredArtifacts: ['report.md', 'findings.json', 'coverage.json'],
  },
};
const recipe = {
  version: '1.0.0',
  title: 'Test fixture',
  description: 'Synthetic contract fixture',
  prompt: 'Return JSON.',
  parameters: ['subnet', 'findingsRepository', 'mode', 'baseline'].map(
    (key) => ({
      key,
      description: key,
      input_type: 'string',
      requirement: 'required',
    }),
  ),
};
function def(overrides = {}) {
  return definition({
    repository: 'example/repo',
    revision: 'a'.repeat(40),
    name: 'audit',
    jobText: JSON.stringify({ ...job, ...overrides }),
    recipeText: JSON.stringify(recipe),
  });
}
function output(status = 'complete') {
  return {
    report: 'Synthetic assessment, not a network scan.',
    findings: { version: 1, items: [] },
    coverage: {
      version: 1,
      scope: '192.0.2.0/24',
      checks: [
        'discovery',
        'ports',
        'services',
        'baseline',
        'existing-issues',
      ].map((name) => ({
        name,
        status,
        evidence: ['synthetic contract fixture'],
      })),
    },
  };
}
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'lcars-jobs-test-'));
  t.onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('discovery freezes committed regular files, reports invalid jobs and ignores dirty content', async (t) => {
  const path = await temporary(t);
  const git = (...args) =>
    execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(path, '.lcars/jobs/audit'), { recursive: true });
  await mkdir(join(path, '.lcars/jobs/broken'), { recursive: true });
  await writeFile(
    join(path, '.lcars/jobs/audit/job.yaml'),
    JSON.stringify(job),
  );
  await writeFile(
    join(path, '.lcars/jobs/audit/recipe.yaml'),
    JSON.stringify(recipe),
  );
  await writeFile(join(path, '.lcars/jobs/broken/job.yaml'), 'version: nope');
  git('add', '.');
  git('commit', '-m', 'inert fixture');
  await writeFile(
    join(path, '.lcars/jobs/audit/job.yaml'),
    'uncommitted: ignored',
  );
  const catalog = discover(path, 'example/repo');
  assert.equal(catalog.jobs.length, 1);
  assert.equal(catalog.errors.length, 1);
  assert.equal(catalog.jobs[0].revision, git('rev-parse', 'HEAD').trim());
  assert.equal(catalog.jobs[0].job.description, job.description);
});

test('rejects oversized or unequal requests, smaller-lane overflow and unavailable profiles', () => {
  for (const resources of [
    { requests: { ...allocation, cpu: 3 }, limits: { ...allocation, cpu: 3 } },
    { requests: allocation, limits: { ...allocation, memory: '5Gi' } },
    {
      requests: { ...allocation, storage: '41Gi' },
      limits: { ...allocation, storage: '41Gi' },
    },
  ])
    assert.throws(() => def({ execution: { ...job.execution, resources } }));
  assert.throws(
    () =>
      admitProfile(def(), {
        ...profile,
        capacity: { ...allocation, memory: '5Gi' },
      }),
    /lane capacity/u,
  );
  assert.throws(() => admitProfile(def(), undefined), /not granted/u);
  assert.throws(
    () => admitProfile(def(), { ...profile, repositories: [] }),
    /not granted/u,
  );
});

test('Sunday schedule preserves local time across daylight-saving transitions', () => {
  assert.equal(dueAt(def(), new Date('2026-10-25T13:00:00Z')), true);
  assert.equal(dueAt(def(), new Date('2026-11-01T14:00:00Z')), true);
  assert.equal(dueAt(def(), new Date('2026-11-01T13:00:00Z')), false);
  assert.equal(dueAt(def(), new Date('2026-10-26T13:00:00Z')), false);
});

test('manual replay, overlap and successful baseline survive controller restart', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'state.sqlite');
  let controller = new JobController(path);
  const first = controller.admit(def(), { requestId: 'first', profile });
  assert.equal(
    controller.admit(def(), { requestId: 'first', profile }).outcome,
    'replay',
  );
  assert.equal(
    controller.admit(def(), { requestId: 'overlap', profile }).outcome,
    'skipped',
  );
  await controller.execute(first.run, async ({ baseline }) => {
    assert.equal(baseline, null);
    return output();
  });
  controller.close();
  controller = new JobController(path);
  t.onTestFinished(() => controller.close());
  assert.equal(controller.baseline(def().id).id, first.run.id);
  const second = controller.admit(def(), { requestId: 'second', profile });
  assert.equal(second.run.baseline, first.run.id);
  const incomplete = await controller.execute(
    second.run,
    async ({ baseline }) => {
      assert.deepEqual(baseline, output().findings);
      return output('failed');
    },
  );
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(controller.baseline(def().id).id, first.run.id);
  assert.equal(
    controller.admit(def(), { requestId: 'overlap', profile }).outcome,
    'replay',
  );
  assert.throws(
    () =>
      controller.admit(def({ description: 'Changed' }), {
        requestId: 'first',
        profile,
      }),
    /different definition/u,
  );
});

test('one schedule occurrence stays pinned across source edits and repeated ticks', () => {
  const controller = new JobController(':memory:');
  try {
    const at = new Date('2026-10-25T13:00:00Z');
    const first = controller.admit(def(), { trigger: 'schedule', at, profile });
    const next = controller.admit(def({ description: 'Changed' }), {
      trigger: 'schedule',
      at,
      profile,
    });
    assert.equal(next.outcome, 'replay');
    assert.equal(next.run.id, first.run.id);
    assert.equal(next.run.definition.job.description, job.description);
  } finally {
    controller.close();
  }
});

test('changing comparison scope starts a new baseline instead of reusing old findings', async () => {
  const controller = new JobController(':memory:');
  try {
    const first = controller.admit(def(), {
      requestId: 'scope-one',
      profile,
    }).run;
    await controller.execute(first, async () => output());
    const changed = def({
      inputs: { ...job.inputs, subnet: '198.51.100.0/24' },
    });
    const second = controller.admit(changed, {
      requestId: 'scope-two',
      profile: { ...profile, subnets: ['198.51.100.0/24'] },
    }).run;
    assert.equal(second.baseline, null);
  } finally {
    controller.close();
  }
});

test('invalid scope or duplicate coverage cannot advance the successful baseline', async () => {
  const controller = new JobController(':memory:');
  try {
    const run = controller.admit(def(), { requestId: 'bad', profile }).run;
    const bad = output();
    bad.coverage.checks[4] = bad.coverage.checks[0];
    const settled = await controller.execute(run, async () => bad);
    assert.equal(settled.status, 'failed');
    assert.equal(controller.baseline(def().id), undefined);
    const wrongScope = output();
    wrongScope.coverage.scope = '0.0.0.0/0';
    const other = controller.admit(def(), {
      requestId: 'wrong-scope',
      profile,
    }).run;
    assert.equal(
      (await controller.execute(other, async () => wrongScope)).status,
      'failed',
    );
  } finally {
    controller.close();
  }
});

test('Goose subprocess adapter handles structured output and terminates cancellation', async (t) => {
  const directory = await temporary(t);
  const executable = join(directory, 'fixture-goose');
  const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output()))});\n`;
  await writeFile(executable, script, { mode: 0o700 });
  const controller = new JobController(':memory:');
  t.onTestFinished(() => controller.close());
  let checked = false;
  const execute = gooseExecutor({
    executable,
    environment: {
      PATH: process.env.PATH,
      HOME: directory,
      GOOSE_CONFIG_DIR: directory,
    },
    assertAllocation: async () => {
      checked = true;
    },
  });
  const run = controller.admit(def(), { requestId: 'process', profile }).run;
  assert.equal((await controller.execute(run, execute)).status, 'succeeded');
  assert.equal(checked, true);
  await writeFile(
    executable,
    '#!/usr/bin/env node\nsetInterval(() => {}, 100);\n',
  );
  const cancel = new AbortController();
  const pending = controller.admit(def(), { requestId: 'cancel', profile }).run;
  setTimeout(() => cancel.abort(), 100);
  assert.equal(
    (await controller.execute(pending, execute, cancel.signal)).status,
    'cancelled',
  );
});

test('allocation guard binds to this process and refuses absent storage proof', async () => {
  await assert.rejects(
    cgroupAllocation(job.execution.resources, {}),
    /limits|storage|cgroup|ENOENT/u,
  );
});

test('execution claim is atomic and caller mutation cannot change the pinned scope', async () => {
  const controller = new JobController(':memory:');
  try {
    const run = controller.admit(def(), { requestId: 'claim', profile }).run;
    run.definition.job.inputs.subnet = '0.0.0.0/0';
    let release;
    const pending = controller.execute(run, async ({ run: stored }) => {
      assert.equal(stored.definition.job.inputs.subnet, '192.0.2.0/24');
      await new Promise((resolve) => {
        release = resolve;
      });
      return output();
    });
    await assert.rejects(
      controller.execute(run, async () => output()),
      /claimed/u,
    );
    release();
    assert.equal((await pending).status, 'succeeded');
  } finally {
    controller.close();
  }
});

test('recovery requires termination proof and fences a late completion', async () => {
  const controller = new JobController(':memory:');
  try {
    const run = controller.admit(def(), { requestId: 'recover', profile }).run;
    let release;
    const pending = controller.execute(run, async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return output();
    });
    const later = new Date(Date.now() + 31 * 60_000);
    await assert.rejects(
      controller.recover(run.id, async () => false, later),
      /unverified/u,
    );
    await controller.recover(run.id, async () => true, later);
    release();
    await assert.rejects(pending, /stale/u);
    assert.equal(controller.baseline(def().id), undefined);
    assert.equal(
      controller.admit(def(), { requestId: 'replacement', profile }).outcome,
      'admitted',
    );
  } finally {
    controller.close();
  }
});
