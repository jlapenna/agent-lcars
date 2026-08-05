import assert from 'node:assert/strict';

import { scanAndRerun } from './main.mjs';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const REPO = 'jlapenna/agent-lcars';
const ROOT = `/repos/${REPO}`;

function step(conclusion) {
  return { name: 'a step', status: 'completed', conclusion };
}

function infraKilledJob(name = 'Verify') {
  return { name, conclusion: 'failure', steps: [step(null), step(null)] };
}

function realFailureJob(name = 'Verify') {
  return {
    name,
    conclusion: 'failure',
    steps: [step('success'), step('failure'), step('skipped')],
  };
}

function workflowRun({
  id,
  runAttempt = 1,
  conclusion = 'failure',
  headSha = `sha-${id}`,
}) {
  return {
    id,
    status: 'completed',
    conclusion,
    run_attempt: runAttempt,
    head_sha: headSha,
    name: 'CI',
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  };
}

// A minimal stand-in for createGitHubApi's returned client: routes on the
// path (ignoring the query string, which callers vary freely) and method,
// recording every call so assertions can check exactly what was and was
// not requested.
function fakeApi(routes) {
  const calls = [];
  return {
    calls,
    async requestOk(path, options = {}) {
      const method = options.method ?? 'GET';
      const basePath = path.split('?')[0];
      calls.push({ path, basePath, method, body: options.body });
      const route = routes.find(
        (candidate) =>
          candidate.path === basePath && (candidate.method ?? 'GET') === method,
      );
      if (!route) {
        throw new Error(`No fake route for ${method} ${basePath}`);
      }
      if (route.error) throw route.error;
      return typeof route.data === 'function'
        ? route.data({ path, options })
        : route.data;
    },
  };
}

test('reruns an infra-killed attempt-1 run exactly once and posts the audit-trail comment on its open PR', async () => {
  const run = workflowRun({ id: 1 });
  const api = fakeApi([
    {
      path: `${ROOT}/actions/workflows/ci.yml/runs`,
      data: { workflow_runs: [run] },
    },
    {
      path: `${ROOT}/actions/runs/1/jobs`,
      data: { jobs: [infraKilledJob()] },
    },
    {
      path: `${ROOT}/actions/runs/1/rerun-failed-jobs`,
      method: 'POST',
      data: {},
    },
    {
      path: `${ROOT}/commits/sha-1/pulls`,
      data: [{ number: 469, state: 'open' }],
    },
    { path: `${ROOT}/issues/469/comments`, method: 'POST', data: {} },
  ]);

  const result = await scanAndRerun({ api, repository: REPO });

  assert.deepEqual(result, { scanned: 1, rerun: 1 });
  const rerunCall = api.calls.find(
    (call) => call.basePath === `${ROOT}/actions/runs/1/rerun-failed-jobs`,
  );
  assert.ok(rerunCall, 'expected the rerun-failed-jobs endpoint to be called');
  const commentCall = api.calls.find(
    (call) => call.basePath === `${ROOT}/issues/469/comments`,
  );
  assert.ok(commentCall, 'expected an audit-trail comment on PR #469');
  assert.match(commentCall.body.body, /Verify/u);
  assert.match(commentCall.body.body, /agent-lcars#536/u);
  assert.match(commentCall.body.body, /runs\/1$/u);
});

test('never re-examines a run already at attempt 2 or higher -- the loop guard holds even under a persistent bad-looking failure', async () => {
  const alreadyRerun = workflowRun({ id: 2, runAttempt: 2 });
  const api = fakeApi([
    {
      path: `${ROOT}/actions/workflows/ci.yml/runs`,
      data: { workflow_runs: [alreadyRerun] },
    },
  ]);

  const result = await scanAndRerun({ api, repository: REPO });

  assert.deepEqual(result, { scanned: 1, rerun: 0 });
  assert.deepEqual(
    api.calls.map((call) => call.basePath),
    [`${ROOT}/actions/workflows/ci.yml/runs`],
    'a run at attempt 2+ must never trigger a jobs fetch, rerun, or comment call',
  );
});

test('never reruns a run whose failed job has a real failed step', async () => {
  const run = workflowRun({ id: 3 });
  const api = fakeApi([
    {
      path: `${ROOT}/actions/workflows/ci.yml/runs`,
      data: { workflow_runs: [run] },
    },
    {
      path: `${ROOT}/actions/runs/3/jobs`,
      data: { jobs: [realFailureJob()] },
    },
  ]);

  const result = await scanAndRerun({ api, repository: REPO });

  assert.deepEqual(result, { scanned: 1, rerun: 0 });
  assert.equal(
    api.calls.some((call) => call.basePath.endsWith('rerun-failed-jobs')),
    false,
    'a real step failure must never be automatically rerun',
  );
});

test('still counts the rerun when no pull request is associated with the run, but skips the comment', async () => {
  const run = workflowRun({ id: 4 });
  const api = fakeApi([
    {
      path: `${ROOT}/actions/workflows/ci.yml/runs`,
      data: { workflow_runs: [run] },
    },
    { path: `${ROOT}/actions/runs/4/jobs`, data: { jobs: [infraKilledJob()] } },
    {
      path: `${ROOT}/actions/runs/4/rerun-failed-jobs`,
      method: 'POST',
      data: {},
    },
    { path: `${ROOT}/commits/sha-4/pulls`, data: [] },
  ]);

  const result = await scanAndRerun({ api, repository: REPO });

  assert.deepEqual(result, { scanned: 1, rerun: 1 });
  assert.equal(
    api.calls.some(
      (call) => call.basePath.includes('/issues/') && call.method === 'POST',
    ),
    false,
    'no PR to comment on means no comment call at all',
  );
});

test('a per-candidate rerun failure is reported but never blocks scanning the rest of the batch', async () => {
  const runA = workflowRun({ id: 5 });
  const runB = workflowRun({ id: 6 });
  const api = fakeApi([
    {
      path: `${ROOT}/actions/workflows/ci.yml/runs`,
      data: { workflow_runs: [runA, runB] },
    },
    { path: `${ROOT}/actions/runs/5/jobs`, data: { jobs: [infraKilledJob()] } },
    {
      path: `${ROOT}/actions/runs/5/rerun-failed-jobs`,
      method: 'POST',
      error: new Error('secondary rate limit'),
    },
    { path: `${ROOT}/actions/runs/6/jobs`, data: { jobs: [infraKilledJob()] } },
    {
      path: `${ROOT}/actions/runs/6/rerun-failed-jobs`,
      method: 'POST',
      data: {},
    },
    { path: `${ROOT}/commits/sha-6/pulls`, data: [] },
  ]);

  const result = await scanAndRerun({ api, repository: REPO });

  // Run 5's rerun call fails; run 6 must still be reran independently.
  assert.deepEqual(result, { scanned: 2, rerun: 1 });
});

test('scans the workflow named by workflowFile instead of the ci.yml default', async () => {
  const run = workflowRun({ id: 9 });
  const api = fakeApi([
    {
      path: `${ROOT}/actions/workflows/validate.yml/runs`,
      data: { workflow_runs: [run] },
    },
    {
      path: `${ROOT}/actions/runs/9/jobs`,
      data: { jobs: [infraKilledJob('repository validation')] },
    },
    {
      path: `${ROOT}/actions/runs/9/rerun-failed-jobs`,
      method: 'POST',
      data: {},
    },
    { path: `${ROOT}/commits/sha-9/pulls`, data: [] },
  ]);

  const result = await scanAndRerun({
    api,
    repository: REPO,
    workflowFile: 'validate.yml',
  });

  assert.deepEqual(result, { scanned: 1, rerun: 1 });
  assert.ok(
    api.calls.every(
      (call) => !call.basePath.includes('/actions/workflows/ci.yml/'),
    ),
    'the ci.yml default must not be queried when workflowFile overrides it',
  );
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
