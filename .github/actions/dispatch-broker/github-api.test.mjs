import assert from 'node:assert/strict';

import {
  acceptIntent,
  beginDispatch,
  createLedger,
  renderLedgerComment,
} from './broker.mjs';
import {
  API_VERSION,
  brokerConcurrencyGroup,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  createGitHubApi,
  ensureNeedsHumanParked,
  failClosed,
  findConflictingRouterRun,
  findRunsForGeneration,
  findSupersedingRouterRun,
  GitHubApiError,
  listOpenAgentLabeledIssues,
  listOpenIssuesAssignedTo,
  loadLedger,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  removeIssueLabel,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
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

test('worker pipeline resolves to exactly one worker workflow file, including the #307 canary', () => {
  assert.equal(workerWorkflow('claude'), 'claude.yml');
  assert.equal(workerWorkflow('codex'), 'codex.yml');
  assert.equal(workerWorkflow('opencode'), 'opencode.yml');
  assert.equal(workerWorkflow('canary'), 'agent-dispatch-canary.yml');
  assert.throws(
    () => workerWorkflow('not-a-real-pipeline'),
    /Unsupported worker pipeline/u,
  );
});

test('broker concurrency group is derived from the TaskRef repository id and issue number', () => {
  assert.equal(brokerConcurrencyGroup(task), 'agent-lcars-dispatch-v1-123-304');
});

// #348's third round (2026-08-04) retired the direct, own-listing
// concurrency check entirely (validateBrokerConcurrencyResponse /
// fetchAndValidateOwnListing, formerly used for "reliable" event types) --
// see the comment above findConflictingRouterRun in github-api.mjs for why.
// verifyBrokerConcurrency's default behavior (no eventName passed at all,
// exactly what a caller gets if it omits the option) now exercises the
// indirect path directly, with the same retry-until-it-clears shape the
// old direct-path test covered.
test('verifyBrokerConcurrency (no eventName) retries an indirect conflict until it clears', async () => {
  const group = brokerConcurrencyGroup(task);
  let listCalls = 0;
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        listCalls += 1;
        // A conflicting run holds the group on the first two attempts, then
        // completes and drops off the in-progress list.
        return {
          workflow_runs:
            listCalls < 3
              ? [{ id: 9500, display_title: 'route #304: labeled agent:codex' }]
              : [],
        };
      }
      if (path.includes('/actions/runs/9500/concurrency_groups')) {
        return { concurrency_groups: [{ group_name: group }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const sleeps = [];
  const result = await verifyBrokerConcurrency(api, task, 9001, group, {
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.group_name, group);
  assert.equal(listCalls, 3);
  assert.deepEqual(sleeps, [
    CONCURRENCY_VERIFY_RETRY_DELAY_MS,
    CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  ]);
});

// #348, across three rounds (all 2026-08-04 except round 1): GitHub's
// /actions/runs/{id}/concurrency_groups listing has now been found
// unreliable for every trigger type sampled, not just workflow_dispatch
// (round 1: 5/5 sampled dispatch runs, some hours old, returned zero
// matches) and pull_request (round 2: 100% failure rate since the broker's
// introduction, still empty hours later on re-probe). Round 3 sampled
// issue_comment (~47% failure rate across 34 concluded runs, including
// solo/uncontested runs like #470's 30927934741 and #480's 30927991852,
// both re-probed and still empty 13+ hours later) and issues (~17% across
// 90 sampled runs, including solo run 30927288777) and found both "reliable
// self-listing" event types were never actually reliable either -- just
// less unreliable. verifyBrokerConcurrency therefore no longer branches on
// eventName at all: every event name (and no event name -- see the
// dedicated no-eventName test above) verifies indirectly via
// findConflictingRouterRun / checkIndirectBrokerConcurrency, and NEVER
// fetches a run's own listing. All are exercised identically below since
// there is no longer a routing decision left to differ per event name.

for (const eventName of [
  'workflow_dispatch',
  'pull_request',
  'issues',
  'issue_comment',
  'a_future_event_type_nobody_has_named_yet',
]) {
  test(`verifyBrokerConcurrency verifies a ${eventName}-triggered run indirectly and never fetches its own listing (#348)`, async () => {
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
        eventName,
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
      `must never fetch its own run listing on the ${eventName} path`,
    );
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^::notice::/u);
    assert.match(logged[0], /indirectly/u);
  });

  test(`verifyBrokerConcurrency retries a ${eventName}-triggered conflict and throws retryable after exhausting attempts (#348)`, async () => {
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
          eventName,
          sleepImpl: async (ms) => {
            sleeps.push(ms);
          },
        }),
      (error) =>
        error.name === 'BrokerConcurrencyMismatchError' &&
        error.retryable === true &&
        /9500/u.test(error.message) &&
        new RegExp(
          `after ${CONCURRENCY_VERIFY_MAX_ATTEMPTS} attempts`,
          'u',
        ).test(error.message),
    );
    assert.equal(calls, CONCURRENCY_VERIFY_MAX_ATTEMPTS);
    assert.deepEqual(
      sleeps,
      Array(CONCURRENCY_VERIFY_MAX_ATTEMPTS - 1).fill(
        CONCURRENCY_VERIFY_RETRY_DELAY_MS,
      ),
    );
  });

  test(`verifyBrokerConcurrency still enforces the supplied-group/TaskRef mismatch on the ${eventName} path, without retrying (#348)`, async () => {
    const group = brokerConcurrencyGroup(task);
    const api = {
      requestOk: async () => {
        throw new Error('must not query GitHub at all for a config mismatch');
      },
    };
    await assert.rejects(
      () =>
        verifyBrokerConcurrency(api, task, 9001, `${group}-wrong`, {
          eventName,
          sleepImpl: async () => {
            throw new Error('must not retry a config mismatch');
          },
        }),
      (error) =>
        error.name === 'BrokerConcurrencyMismatchError' &&
        error.retryable === false,
    );
  });
}

// Regression guard for #348's third round: before this fix, 'issues' and
// 'issue_comment' each took the direct, own-listing path (as did any
// eventName not in the allowlist's complement, and no-eventName-at-all
// fell back to it too), so a persistently empty own listing -- which
// production showed happens for a real, nonzero fraction of solo,
// uncontested runs of exactly these two event types -- retried to
// exhaustion and failed closed. Confirms NO event name (nor omitting it
// entirely) ever touches run 9001's own listing anymore, even when that
// listing would report a clean, unambiguous "yes, I hold it" if asked --
// proving the old allowlist is gone, not just rebalanced.
test('verifyBrokerConcurrency never touches its own listing for any event name, including issues/issue_comment/no event name at all', async () => {
  const group = brokerConcurrencyGroup(task);
  const ownListingRequests = [];
  const api = {
    requestOk: async (path) => {
      if (path.includes('/actions/runs/9001/concurrency_groups')) {
        ownListingRequests.push(path);
        // Even a definite, unambiguous "yes" here must never be consulted.
        return { concurrency_groups: [{ group_name: group }] };
      }
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return { workflow_runs: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  for (const eventName of ['issues', 'issue_comment', undefined]) {
    const result = await verifyBrokerConcurrency(api, task, 9001, group, {
      eventName,
      sleepImpl: async () => {
        throw new Error('must not retry a clean pass');
      },
    });
    assert.equal(result.group_name, group);
  }
  assert.deepEqual(ownListingRequests, []);
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

test('listOpenAgentLabeledIssues queries all three agent labels and all three review labels, deduping by issue number (#305, #567)', async () => {
  const seen = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes('labels=agent%3Aclaude')) {
        return response(200, [{ number: 10 }, { number: 5 }]);
      }
      if (url.includes('labels=agent%3Acodex')) {
        // Same issue #5 reported under a second label -- a (invalid)
        // contradictory-label issue must still only be scanned once.
        return response(200, [{ number: 5 }]);
      }
      if (url.includes('labels=agent%3Aopencode')) {
        return response(200, [{ number: 20 }]);
      }
      if (url.includes('labels=review%3Aclaude')) {
        return response(200, [{ number: 30 }]);
      }
      if (
        url.includes('labels=review%3Acodex') ||
        url.includes('labels=review%3Aopencode')
      ) {
        return response(200, []);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const issues = await listOpenAgentLabeledIssues(api, task);
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [5, 10, 20, 30],
  );
  assert.equal(seen.length, 6);
  for (const url of seen) assert.match(url, /state=open/u);
});

test('listOpenAgentLabeledIssues paginates a single label past 100 results', async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
  }));
  const requestedPages = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      if (url.includes('labels=agent%3Aclaude')) {
        const page = Number(new URL(url).searchParams.get('page'));
        requestedPages.push(page);
        return response(200, page === 1 ? pageOne : [{ number: 101 }]);
      }
      return response(200, []);
    },
  });
  const issues = await listOpenAgentLabeledIssues(api, task);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(issues.length, 101);
});

test('listOpenIssuesAssignedTo queries the exact assignee login and paginates (#363 review)', async () => {
  const seen = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      seen.push(url);
      assert.ok(url.includes('state=open'));
      assert.ok(url.includes('assignee=jclaw-bot'));
      return response(200, [{ number: 500 }]);
    },
  });
  const issues = await listOpenIssuesAssignedTo(api, task, 'jclaw-bot');
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [500],
  );
  assert.equal(seen.length, 1);
});

test('listOpenIssuesAssignedTo is a no-op returning no requests when no login is configured', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => {
      throw new Error('must not call the API without a configured login');
    },
  });
  assert.deepEqual(await listOpenIssuesAssignedTo(api, task, ''), []);
  assert.deepEqual(await listOpenIssuesAssignedTo(api, task, undefined), []);
});

function dispatchingGeneration({
  dispatchStartedAt = '2026-08-01T00:00:00.000Z',
} = {}) {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-1',
    sourceKind: 'manual',
    sourceId: 'source-1',
    transportRunId: 9001,
    occurredAt: dispatchStartedAt,
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'abc',
    authorization: { authorized: true },
  });
  beginDispatch(ledger, 1, 'dispatch_token_123456', dispatchStartedAt);
  return ledger.generations[0];
}

test('findRunsForGeneration scopes the query to runs created at or after the generation was dispatched (#363 review)', async () => {
  const generation = dispatchingGeneration({
    dispatchStartedAt: '2026-08-01T12:00:00.000Z',
  });
  let requestedUrl;
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response(200, { workflow_runs: [] });
    },
  });
  await findRunsForGeneration(api, task, generation);
  const created = new URL(requestedUrl).searchParams.get('created');
  assert.ok(created, 'expected a created= query parameter');
  assert.match(created, /^>=2026-08-01T11:5\d:00\.000Z$/u);
});

test('findRunsForGeneration paginates within the scoped window and finds a run that an unscoped, unpaginated 100-result page would have truncated (#363 review)', async () => {
  const generation = dispatchingGeneration();
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  const targetRun = {
    id: 999,
    display_title: `#304: Codex ${marker}`,
  };
  // Page 1 is entirely unrelated newer traffic (a full page -- signals more
  // may exist); the actual match only appears on page 2. An unscoped,
  // unpaginated per_page=100 call would see only page 1 and wrongly report
  // "no matching run".
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    display_title: `#999: unrelated run ${index}`,
  }));
  const requestedPages = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requestedPages.push(page);
      if (page === 1) return response(200, { workflow_runs: pageOne });
      return response(200, { workflow_runs: [targetRun] });
    },
  });
  const matches = await findRunsForGeneration(api, task, generation);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(
    matches.map((run) => run.id),
    [999],
  );
});

test('findRunsForGeneration accumulates matches across pages rather than stopping at the first one, so a duplicate landing on a later page is still detected', async () => {
  const generation = dispatchingGeneration();
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  const firstMatch = { id: 1, display_title: `#304: Codex ${marker}` };
  const secondMatch = { id: 2, display_title: `#304: Codex ${marker}` };
  const pageOne = [
    firstMatch,
    ...Array.from({ length: 99 }, (_, index) => ({
      id: 100 + index,
      display_title: `#999: unrelated run ${index}`,
    })),
  ];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return response(200, { workflow_runs: pageOne });
      if (page === 2) return response(200, { workflow_runs: [secondMatch] });
      return response(200, { workflow_runs: [] });
    },
  });
  const matches = await findRunsForGeneration(api, task, generation);
  assert.deepEqual(matches.map((run) => run.id).sort(), [1, 2]);
});

test('findRunsForGeneration gives up after its bounded page limit rather than scanning forever', async () => {
  const generation = dispatchingGeneration();
  let requests = 0;
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    display_title: `#999: unrelated run ${index}`,
  }));
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => {
      requests += 1;
      return response(200, { workflow_runs: fullPage });
    },
  });
  const matches = await findRunsForGeneration(api, task, generation);
  assert.deepEqual(matches, []);
  assert.equal(requests, 5); // FIND_RUNS_FOR_GENERATION_MAX_PAGES
});

test('ensureNeedsHumanParked applies the label and assignee on success, with no verification re-reads', async () => {
  const calls = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return response(200, {});
    },
  });
  await ensureNeedsHumanParked(api, task, 'jlapenna');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/labels$/u);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[1].url, /\/assignees$/u);
  assert.equal(calls[1].method, 'POST');
});

test('failClosed parks the anchor and rethrows the original broker error', async () => {
  const calls = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return response(200, {});
    },
  });
  const original = new GitHubApiError('ledger write failed', 500, {
    message: 'boom',
  });
  await assert.rejects(
    () => failClosed(api, task, 'jlapenna', original),
    (error) => error === original,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/labels$/u);
  assert.match(calls[1].url, /\/assignees$/u);
});

test('failClosed preserves both the broker error and a fallback parking error', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/labels')) {
        return response(403, { message: 'parking forbidden' });
      }
      if (url.includes(`/issues/${task.issue}`)) {
        return response(200, { labels: [], assignees: [] });
      }
      throw new Error(`Unexpected API request: ${options.method} ${url}`);
    },
  });
  const original = new GitHubApiError('ledger write failed', 500, {
    message: 'broker boom',
  });
  await assert.rejects(
    () => failClosed(api, task, 'jlapenna', original),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.errors[0], original);
      assert.ok(error.errors[1] instanceof GitHubApiError);
      assert.equal(error.errors[1].status, 403);
      assert.match(error.message, /fail-closed parking also failed/u);
      return true;
    },
  );
});

test('ensureNeedsHumanParked skips the assignee mutation entirely when no maintainer is configured', async () => {
  const calls = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      calls.push(url);
      return response(200, {});
    },
  });
  await ensureNeedsHumanParked(api, task, '');
  assert.equal(calls.length, 1);
});

test('ensureNeedsHumanParked verify-then-decides a label POST failure that actually landed (#346 pattern)', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/labels')) {
        return response(422, { message: 'response-parse hiccup' });
      }
      if (url.endsWith(`/issues/${task.issue}`)) {
        return response(200, {
          labels: [{ name: 'status:needs-human' }],
          assignees: [{ login: 'jlapenna' }],
        });
      }
      return response(200, {});
    },
  });
  await assert.doesNotReject(() =>
    ensureNeedsHumanParked(api, task, 'jlapenna'),
  );
});

test('ensureNeedsHumanParked throws when a label mutation genuinely failed and verification confirms absence', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/labels')) {
        return response(403, { message: 'Forbidden' });
      }
      if (url.endsWith(`/issues/${task.issue}`)) {
        return response(200, { labels: [], assignees: [] });
      }
      return response(200, {});
    },
  });
  await assert.rejects(
    () => ensureNeedsHumanParked(api, task, 'jlapenna'),
    (error) => error instanceof GitHubApiError && error.status === 403,
  );
});

test('ensureNeedsHumanParked verify-then-decides an assignee POST failure that actually landed', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/labels')) {
        return response(200, {});
      }
      if (options.method === 'POST' && url.endsWith('/assignees')) {
        return response(422, { message: 'response-parse hiccup' });
      }
      if (url.endsWith(`/issues/${task.issue}`)) {
        return response(200, {
          labels: [],
          assignees: [{ login: 'jlapenna' }],
        });
      }
      return response(200, {});
    },
  });
  await assert.doesNotReject(() =>
    ensureNeedsHumanParked(api, task, 'jlapenna'),
  );
});

test('ensureNeedsHumanParked throws when an assignee mutation genuinely failed and verification confirms absence', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/labels')) {
        return response(200, {});
      }
      if (options.method === 'POST' && url.endsWith('/assignees')) {
        return response(403, { message: 'Forbidden' });
      }
      if (url.endsWith(`/issues/${task.issue}`)) {
        return response(200, { labels: [], assignees: [] });
      }
      return response(200, {});
    },
  });
  await assert.rejects(
    () => ensureNeedsHumanParked(api, task, 'jlapenna'),
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

// PR #374 review (P2): a bare Promise.all(Settled) over a large discovered
// backlog fires one request per candidate simultaneously and risks
// tripping GitHub's secondary rate limits -- mapWithConcurrency is the
// bounded-pool replacement dispatchReconcileScan and sweepStaleCanaries
// both use. Assert it (a) never lets more than `limit` workers run at
// once, (b) still attempts every item, and (c) preserves per-item success
// or failure -- and their original order -- exactly like
// Promise.allSettled would.
test('mapWithConcurrency bounds in-flight work to the given limit while still processing every item', async () => {
  const limit = 3;
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 11 }, (_, index) => index);
  const results = await mapWithConcurrency(items, limit, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (item === 4) throw new Error(`boom-${item}`);
    return item * 2;
  });
  assert.equal(active, 0, 'every worker must have finished');
  assert.ok(
    maxActive <= limit,
    `expected at most ${limit} concurrent workers, saw ${maxActive}`,
  );
  assert.equal(
    maxActive,
    limit,
    'expected the pool to actually reach its concurrency limit given more items than the limit',
  );
  assert.equal(results.length, items.length);
  results.forEach((result, index) => {
    if (index === 4) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /boom-4/u);
    } else {
      assert.equal(result.status, 'fulfilled');
      assert.equal(result.value, index * 2);
    }
  });
});

test('mapWithConcurrency never starts more workers than there are items', async () => {
  let concurrentCalls = 0;
  const results = await mapWithConcurrency([1, 2], 5, async (item) => {
    concurrentCalls += 1;
    return item;
  });
  assert.equal(concurrentCalls, 2);
  assert.deepEqual(
    results.map((result) => result.value),
    [1, 2],
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
