import assert from 'node:assert/strict';

import { createLedger, renderLedgerComment } from './broker.mjs';
import {
  API_VERSION,
  brokerConcurrencyGroup,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  createGitHubApi,
  findConflictingRouterRun,
  findSupersedingRouterRun,
  GitHubApiError,
  loadLedger,
  pinLedgerWhenUnoccupied,
  removeIssueLabel,
  validateBrokerConcurrencyResponse,
  validateDispatchResponse,
  verifyBrokerConcurrency,
} from './github-api.mjs';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const task = {
  repositoryId: 123,
  repository: 'jlapenna/agent-lcars',
  issue: 304,
};

function response(status, data) {
  return {
    status,
    headers: new Headers(),
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  };
}

test('every request pins the 2026-03-10 API contract', async () => {
  let request;
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { ok: true });
    },
  });
  await api.requestOk('/test');
  assert.equal(request.options.headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(API_VERSION, '2026-03-10');
});

test('dispatch requires 200 with same-repository run details', () => {
  const valid = validateDispatchResponse(
    {
      status: 200,
      data: {
        workflow_run_id: 42,
        run_url:
          'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
        html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
      },
    },
    task,
  );
  assert.equal(valid.runId, 42);
  for (const invalid of [
    { status: 204 },
    { status: 200, data: {} },
    {
      status: 200,
      data: {
        workflow_run_id: 42,
        run_url: 'https://api.github.com/repos/attacker/repo/actions/runs/42',
        html_url: 'https://github.com/attacker/repo/actions/runs/42',
      },
    },
    {
      status: 200,
      data: {
        workflow_run_id: 42,
        run_url:
          'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/43',
        html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/43',
      },
    },
  ]) {
    assert.throws(() => validateDispatchResponse(invalid, task));
  }
});

test('broker concurrency must match the canonical task and reported run group', () => {
  const group = brokerConcurrencyGroup(task);
  assert.equal(group, 'agent-lcars-dispatch-v1-123-304');
  assert.equal(
    validateBrokerConcurrencyResponse(
      {
        concurrency_groups: [
          { group_name: group.toUpperCase(), group_members: [] },
        ],
      },
      task,
      9001,
      group,
    ).group_name,
    group.toUpperCase(),
  );
  for (const [data, supplied] of [
    [{ concurrency_groups: [] }, group],
    [
      {
        concurrency_groups: [
          { group_name: group },
          { group_name: group.toUpperCase() },
        ],
      },
      group,
    ],
    [{ concurrency_groups: [{ group_name: 'different' }] }, group],
    [{ concurrency_groups: [{ group_name: group }] }, `${group}-wrong`],
  ]) {
    assert.throws(() =>
      validateBrokerConcurrencyResponse(data, task, 9001, supplied),
    );
  }
});

test('verifyBrokerConcurrency retries a missing group until it materializes', async () => {
  const group = brokerConcurrencyGroup(task);
  let calls = 0;
  const api = {
    requestOk: async () => {
      calls += 1;
      // Absent on the first two fetches, then GitHub's listing catches up.
      if (calls < 3) return { concurrency_groups: [] };
      return { concurrency_groups: [{ group_name: group, group_members: [] }] };
    },
  };
  const sleeps = [];
  const result = await verifyBrokerConcurrency(api, task, 9001, group, {
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.group_name, group);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [
    CONCURRENCY_VERIFY_RETRY_DELAY_MS,
    CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  ]);
});

test('verifyBrokerConcurrency throws after exhausting bounded retries when the group never appears', async () => {
  const group = brokerConcurrencyGroup(task);
  let calls = 0;
  let sleepCount = 0;
  const api = {
    requestOk: async () => {
      calls += 1;
      return { concurrency_groups: [] };
    },
  };
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, group, {
        sleepImpl: async () => {
          sleepCount += 1;
        },
      }),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === true &&
      new RegExp(`after ${CONCURRENCY_VERIFY_MAX_ATTEMPTS} attempts`, 'u').test(
        error.message,
      ),
  );
  assert.equal(calls, CONCURRENCY_VERIFY_MAX_ATTEMPTS);
  assert.equal(sleepCount, CONCURRENCY_VERIFY_MAX_ATTEMPTS - 1);
});

test('verifyBrokerConcurrency throws immediately on more than one matching group, without retrying', async () => {
  const group = brokerConcurrencyGroup(task);
  let calls = 0;
  const api = {
    requestOk: async () => {
      calls += 1;
      return {
        concurrency_groups: [
          { group_name: group },
          { group_name: group.toUpperCase() },
        ],
      };
    },
  };
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, group, {
        sleepImpl: async () => {
          throw new Error('must not retry a real anomaly');
        },
      }),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
});

test('verifyBrokerConcurrency throws immediately on a supplied-group/TaskRef mismatch, without retrying', async () => {
  const group = brokerConcurrencyGroup(task);
  let calls = 0;
  const api = {
    requestOk: async () => {
      calls += 1;
      return { concurrency_groups: [{ group_name: group }] };
    },
  };
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, `${group}-wrong`, {
        sleepImpl: async () => {
          throw new Error('must not retry a config mismatch');
        },
      }),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
});

// #348: GitHub's /actions/runs/{id}/concurrency_groups listing never
// reports membership for workflow_dispatch-triggered runs (empirically
// confirmed: 5/5 sampled dispatch runs, some hours old, returned zero
// matches; every sampled issues-event run returned exactly one). Passing
// eventName: 'workflow_dispatch' switches verifyBrokerConcurrency onto the
// indirect path (findConflictingRouterRun / checkDispatchBrokerConcurrency)
// instead of ever fetching this run's own (always-empty) listing.

test('verifyBrokerConcurrency verifies a dispatch-triggered run indirectly and never fetches its own listing (#348)', async () => {
  const group = brokerConcurrencyGroup(task);
  const requests = [];
  const api = {
    requestOk: async (path) => {
      requests.push(path);
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            { id: 8000, display_title: 'route #999: unrelated issue' },
          ],
        };
      }
      if (path.includes('/actions/runs/8000/concurrency_groups')) {
        return {
          concurrency_groups: [{ group_name: 'a-totally-different-group' }],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const originalLog = console.log;
  const logged = [];
  console.log = (message) => logged.push(message);
  let result;
  try {
    result = await verifyBrokerConcurrency(api, task, 9001, group, {
      eventName: 'workflow_dispatch',
      sleepImpl: async () => {
        throw new Error('must not retry a clean pass');
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.group_name, group);
  assert.equal(
    requests.some((path) =>
      path.includes('/actions/runs/9001/concurrency_groups'),
    ),
    false,
    'must never fetch its own run listing on the dispatch path',
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^::notice::/u);
  assert.match(logged[0], /indirectly/u);
});

test('verifyBrokerConcurrency retries a dispatch-triggered conflict and throws retryable after exhausting attempts (#348)', async () => {
  const group = brokerConcurrencyGroup(task);
  let calls = 0;
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        calls += 1;
        return {
          workflow_runs: [
            { id: 9500, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9500/concurrency_groups')) {
        return { concurrency_groups: [{ group_name: group }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const sleeps = [];
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, group, {
        eventName: 'workflow_dispatch',
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      }),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === true &&
      /9500/u.test(error.message) &&
      new RegExp(`after ${CONCURRENCY_VERIFY_MAX_ATTEMPTS} attempts`, 'u').test(
        error.message,
      ),
  );
  assert.equal(calls, CONCURRENCY_VERIFY_MAX_ATTEMPTS);
  assert.deepEqual(
    sleeps,
    Array(CONCURRENCY_VERIFY_MAX_ATTEMPTS - 1).fill(
      CONCURRENCY_VERIFY_RETRY_DELAY_MS,
    ),
  );
});

test('verifyBrokerConcurrency still enforces the supplied-group/TaskRef mismatch on the dispatch path, without retrying (#348)', async () => {
  const group = brokerConcurrencyGroup(task);
  const api = {
    requestOk: async () => {
      throw new Error('must not query GitHub at all for a config mismatch');
    },
  };
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, `${group}-wrong`, {
        eventName: 'workflow_dispatch',
        sleepImpl: async () => {
          throw new Error('must not retry a config mismatch');
        },
      }),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === false,
  );
});

test('findConflictingRouterRun finds another in-progress run that already holds the expected group', async () => {
  const group = brokerConcurrencyGroup(task);
  const requests = [];
  const api = {
    requestOk: async (path) => {
      requests.push(path);
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            // Excluded: this is our own run.
            { id: 9001, display_title: 'route #304: manual' },
            // Newest candidate, checked first, but does not hold the group.
            { id: 9010, display_title: 'route #304: labeled agent:claude' },
            // Older candidate that genuinely holds the group.
            { id: 9005, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9010/concurrency_groups')) {
        return { concurrency_groups: [] };
      }
      if (path.includes('/actions/runs/9005/concurrency_groups')) {
        return { concurrency_groups: [{ group_name: group.toUpperCase() }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const conflicting = await findConflictingRouterRun(api, task, 9001);
  assert.equal(conflicting.id, 9005);
  // Never asked about run 9001 (itself) and checked the newer non-matching
  // candidate (9010) before the real conflict (9005), proving it doesn't
  // stop at the first candidate and correctly excludes itself.
  assert.deepEqual(
    requests.filter((path) => path.includes('/concurrency_groups')),
    [
      `/repos/jlapenna/agent-lcars/actions/runs/9010/concurrency_groups?per_page=100`,
      `/repos/jlapenna/agent-lcars/actions/runs/9005/concurrency_groups?per_page=100`,
    ],
  );
});

test('findConflictingRouterRun returns undefined when no other in-progress run holds the expected group', async () => {
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            { id: 9005, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/concurrency_groups')) {
        return { concurrency_groups: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  assert.equal(await findConflictingRouterRun(api, task, 9001), undefined);
});

test('findConflictingRouterRun skips a candidate whose own fetch fails rather than aborting the search', async () => {
  const group = brokerConcurrencyGroup(task);
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            { id: 9010, display_title: 'route #304: labeled agent:codex' },
            { id: 9005, display_title: 'route #304: labeled agent:claude' },
          ],
        };
      }
      if (path.includes('/actions/runs/9010/concurrency_groups')) {
        throw new Error('transient fetch failure');
      }
      if (path.includes('/actions/runs/9005/concurrency_groups')) {
        return { concurrency_groups: [{ group_name: group }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const conflicting = await findConflictingRouterRun(api, task, 9001);
  assert.equal(conflicting.id, 9005);
});

// PR #349 review (P1): an inspection failure must never be silently
// downgraded to "no conflict" -- that would fail-open on exactly the error
// path this whole mechanism exists to guard.

test('findConflictingRouterRun throws a retryable, inconclusive error naming the candidate that could not be inspected when nothing else resolves a definite conflict', async () => {
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            { id: 9010, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9010/concurrency_groups')) {
        throw new Error('transient fetch failure');
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  await assert.rejects(
    () => findConflictingRouterRun(api, task, 9001),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === true &&
      /9010/u.test(error.message),
  );
});

test('verifyBrokerConcurrency verifies a dispatch-triggered run after a candidate lookup fails once then succeeds showing no conflict (#349 review)', async () => {
  const group = brokerConcurrencyGroup(task);
  let inspectionAttempts = 0;
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            { id: 9010, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9010/concurrency_groups')) {
        inspectionAttempts += 1;
        if (inspectionAttempts === 1)
          throw new Error('transient fetch failure');
        return { concurrency_groups: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const sleeps = [];
  const originalLog = console.log;
  const logged = [];
  console.log = (message) => logged.push(message);
  let result;
  try {
    result = await verifyBrokerConcurrency(api, task, 9001, group, {
      eventName: 'workflow_dispatch',
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.group_name, group);
  assert.equal(inspectionAttempts, 2);
  assert.deepEqual(sleeps, [CONCURRENCY_VERIFY_RETRY_DELAY_MS]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^::notice::/u);
});

test('verifyBrokerConcurrency throws after exhausting retries when a candidate lookup persistently fails to resolve (#349 review)', async () => {
  const group = brokerConcurrencyGroup(task);
  let listCalls = 0;
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        listCalls += 1;
        return {
          workflow_runs: [
            { id: 9010, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9010/concurrency_groups')) {
        throw new Error('persistent fetch failure');
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const sleeps = [];
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, group, {
        eventName: 'workflow_dispatch',
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      }),
    (error) =>
      error.name === 'BrokerConcurrencyMismatchError' &&
      error.retryable === true &&
      /9010/u.test(error.message) &&
      new RegExp(`after ${CONCURRENCY_VERIFY_MAX_ATTEMPTS} attempts`, 'u').test(
        error.message,
      ),
  );
  assert.equal(listCalls, CONCURRENCY_VERIFY_MAX_ATTEMPTS);
  assert.deepEqual(
    sleeps,
    Array(CONCURRENCY_VERIFY_MAX_ATTEMPTS - 1).fill(
      CONCURRENCY_VERIFY_RETRY_DELAY_MS,
    ),
  );
});

test('findSupersedingRouterRun finds a strictly newer run that already holds the expected group (#344)', async () => {
  const group = brokerConcurrencyGroup(task);
  const requests = [];
  const api = {
    requestOk: async (path) => {
      requests.push(path);
      if (path.includes('/workflows/agent-router.yml/runs?')) {
        return {
          workflow_runs: [
            // Older than this run: not a candidate even though its title
            // matches -- an evicting run must be newer.
            { id: 8998, display_title: 'route #304: unlabeled agent:codex' },
            // Different issue: must not match on a numeric prefix collision.
            { id: 9005, display_title: 'route #3040: labeled agent:codex' },
            // Newest, same issue, but does not itself hold the group (e.g.
            // it is still mid-listing-lag too) -- checked first (highest
            // ID) and must not short-circuit the search.
            { id: 9004, display_title: 'route #304: labeled agent:claude' },
            // Newer than this run but older than 9004; holds the group and
            // is the real superseder.
            { id: 9003, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9004/concurrency_groups')) {
        return { concurrency_groups: [] };
      }
      if (path.includes('/actions/runs/9003/concurrency_groups')) {
        return { concurrency_groups: [{ group_name: group.toUpperCase() }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const superseding = await findSupersedingRouterRun(api, task, 9001);
  assert.equal(superseding.id, 9003);
  // Checked the newer non-matching candidate (9004, sorted first
  // descending) before finding 9003 -- proves it doesn't stop at the
  // first candidate, and never asked about 8998 or 9005 (id <= 9001, or
  // wrong issue) at all.
  assert.deepEqual(
    requests.filter((path) => path.includes('/concurrency_groups')),
    [
      `/repos/jlapenna/agent-lcars/actions/runs/9004/concurrency_groups?per_page=100`,
      `/repos/jlapenna/agent-lcars/actions/runs/9003/concurrency_groups?per_page=100`,
    ],
  );
});

test('findSupersedingRouterRun returns undefined when no candidate run holds the expected group', async () => {
  const api = {
    requestOk: async (path) => {
      if (path.includes('/workflows/agent-router.yml/runs?')) {
        return {
          workflow_runs: [
            { id: 9003, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9003/concurrency_groups')) {
        return { concurrency_groups: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  assert.equal(await findSupersedingRouterRun(api, task, 9001), undefined);
});

test('findSupersedingRouterRun skips a candidate whose own fetch fails rather than aborting the search', async () => {
  const group = brokerConcurrencyGroup(task);
  const api = {
    requestOk: async (path) => {
      if (path.includes('/workflows/agent-router.yml/runs?')) {
        return {
          workflow_runs: [
            { id: 9004, display_title: 'route #304: labeled agent:codex' },
            { id: 9003, display_title: 'route #304: labeled agent:claude' },
          ],
        };
      }
      if (path.includes('/actions/runs/9004/concurrency_groups')) {
        throw new Error('transient fetch failure');
      }
      if (path.includes('/actions/runs/9003/concurrency_groups')) {
        return { concurrency_groups: [{ group_name: group }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const superseding = await findSupersedingRouterRun(api, task, 9001);
  assert.equal(superseding.id, 9003);
});

test('ledger loading rejects duplicates and unexpected authors', async () => {
  const ledger = createLedger(task);
  const body = renderLedgerComment(ledger);
  for (const comments of [
    [
      { id: 1, body, user: { login: 'github-actions[bot]', type: 'Bot' } },
      { id: 2, body, user: { login: 'github-actions[bot]', type: 'Bot' } },
    ],
    [{ id: 1, body, user: { login: 'human', type: 'User' } }],
  ]) {
    const api = createGitHubApi({
      token: 'token',
      fetchImpl: async () => response(200, comments),
    });
    await assert.rejects(() => loadLedger(api, task));
  }
});

test('missing ledger is created once and pinned only with an unoccupied issue pin', async () => {
  const requests = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'POST') {
        return response(201, {
          id: 9,
          body: JSON.parse(options.body).body,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        });
      }
      if (options.method === 'PUT') return response(200, { id: 9 });
      return response(200, []);
    },
  });
  const loaded = await loadLedger(api, task);
  assert.equal(loaded.created, true);
  assert.equal(
    (await pinLedgerWhenUnoccupied(api, loaded, false)).pinned,
    true,
  );
  assert.equal(
    requests.filter((request) => request.options.method === 'POST').length,
    1,
  );

  const occupied = {
    ...loaded,
    existingComments: [{ pin: { pinned_at: 'now' } }],
  };
  assert.equal(
    (await pinLedgerWhenUnoccupied(api, occupied, false)).reason,
    'occupied',
  );
  assert.equal(
    (await pinLedgerWhenUnoccupied(api, loaded, true)).reason,
    'ineligible',
  );
});

test('removeIssueLabel DELETEs the exact encoded label path and reports success on 200', async () => {
  let request;
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, [{ name: 'agent:claude' }]);
    },
  });
  const result = await removeIssueLabel(api, task, 'agent:codex');
  assert.equal(
    request.url,
    'https://api.github.com/repos/jlapenna/agent-lcars/issues/304/labels/agent%3Acodex',
  );
  assert.equal(request.options.method, 'DELETE');
  assert.deepEqual(result, { removed: true });
});

test('removeIssueLabel treats an already-absent label (404) as benign, not an error (#304 self-heal idempotency)', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => response(404, { message: 'Label does not exist' }),
  });
  const result = await removeIssueLabel(api, task, 'agent:codex');
  assert.deepEqual(result, { removed: false });
});

test('removeIssueLabel propagates a genuine failure so the broker falls back to fail-closed', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => response(403, { message: 'Forbidden' }),
  });
  await assert.rejects(
    () => removeIssueLabel(api, task, 'agent:codex'),
    (error) => error instanceof GitHubApiError && error.status === 403,
  );
});

test('transport loss is distinguishable from a definite HTTP rejection', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => {
      throw new Error('timeout');
    },
  });
  await assert.rejects(
    () => api.request('/dispatch', { method: 'POST' }),
    (error) =>
      error.status === undefined && /transport failure/u.test(error.message),
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
