import assert from 'node:assert/strict';

import { formatRouterGroupMarker } from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import {
  acceptIntent,
  beginDispatch,
  createLedger,
  renderLedgerComment,
} from './broker.js';
import {
  agentWorkerPipelines,
  API_VERSION,
  brokerConcurrencyGroup,
  CLOSED_SWEEP_WINDOW_MS,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  createGitHubApi,
  ensureNeedsHumanParked,
  failClosed,
  findConflictingRouterRun,
  findRunsForGeneration,
  findSupersedingRouterRun,
  GitHubApiError,
  hasLedgerProjection,
  listOpenAgentLabeledIssues,
  listOpenIssuesAssignedTo,
  listRecentlyClosedAgentLabeledIssues,
  listRecentlyClosedIssuesAssignedTo,
  loadLedger,
  loadLedgerProjection,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  removeIssueLabel,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
} from './github-api.js';

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
  assert.deepEqual(agentWorkerPipelines, ['claude', 'codex', 'opencode']);
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
function routerGroupMarker(issue = task.issue) {
  return formatRouterGroupMarker({ repositoryId: task.repositoryId, issue });
}

test('verifyBrokerConcurrency (no eventName) retries an indirect conflict until it clears', async () => {
  const group = brokerConcurrencyGroup(task);
  const marker = routerGroupMarker();
  let listCalls = 0;
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        listCalls += 1;
        // A conflicting run carries this task's router-group marker on the
        // first two attempts, then completes and drops off the in-progress
        // list.
        return {
          workflow_runs:
            listCalls < 3
              ? [
                  {
                    id: 9500,
                    display_title: `route #304: labeled agent:codex ${marker}`,
                  },
                ]
              : [],
        };
      }
      if (path.includes('/actions/runs/9500/jobs')) {
        // Its broker job -- not just normalize -- is genuinely in progress
        // on the attempts where it's still listed, so it really does hold
        // the group.
        return { jobs: [{ name: 'broker', status: 'in_progress' }] };
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

// #545: the indirect check no longer branches on eventName (unchanged since
// #348's third round) AND no longer reads the flaky `concurrency_groups`
// sub-resource at all -- it matches the router-group marker
// (`formatRouterGroupMarker`/`parseRouterGroupMarker`,
// libs/dispatch-contracts/src/marker.js) straight off the reliable run
// listing. All trigger types are exercised identically below since there is
// no longer a routing decision, nor a per-run inspection, to differ by event
// name.

for (const eventName of [
  'workflow_dispatch',
  'pull_request',
  'issues',
  'issue_comment',
  'a_future_event_type_nobody_has_named_yet',
]) {
  test(`verifyBrokerConcurrency verifies a ${eventName}-triggered run indirectly via the router-group marker (#545)`, async () => {
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
              {
                id: 8000,
                display_title: `route #999: unrelated issue ${routerGroupMarker(999)}`,
              },
            ],
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
      requests.some((path) => path.includes('/concurrency_groups')),
      false,
      `must never fetch any run's concurrency_groups sub-resource on the ${eventName} path (#545)`,
    );
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^::notice::/u);
    assert.match(logged[0], /indirectly/u);
  });

  test(`verifyBrokerConcurrency retries a ${eventName}-triggered conflict and throws retryable after exhausting attempts (#348)`, async () => {
    const group = brokerConcurrencyGroup(task);
    const marker = routerGroupMarker();
    let calls = 0;
    const api = {
      requestOk: async (path) => {
        if (
          path.includes('/workflows/agent-router.yml/runs?status=in_progress')
        ) {
          calls += 1;
          return {
            workflow_runs: [
              {
                id: 9500,
                display_title: `route #304: labeled agent:codex ${marker}`,
              },
            ],
          };
        }
        if (path.includes('/actions/runs/9500/jobs')) {
          // Its broker job is genuinely in progress on every attempt, so
          // the retry budget genuinely exhausts against a real conflict.
          return { jobs: [{ name: 'broker', status: 'in_progress' }] };
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

// Regression guard for #545: before this fix, a clean pass still required
// trusting each candidate's OWN `concurrency_groups` listing (or, before
// #348's third round, this run's own listing on the now-retired direct
// path). Confirms NO event name (nor omitting it entirely) ever fetches
// that sub-resource for ANY run, self or otherwise -- the conflict check now
// resolves entirely from the one listing request's inline `display_title`
// fields.
test("verifyBrokerConcurrency never fetches any run's concurrency_groups sub-resource, for any event name including none (#545)", async () => {
  const group = brokerConcurrencyGroup(task);
  const requests = [];
  const api = {
    requestOk: async (path) => {
      requests.push(path);
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
  assert.deepEqual(
    requests.filter((path) => path.includes('/concurrency_groups')),
    [],
  );
});

test('verifyBrokerConcurrency fails closed (propagates, never verifies) when the in-progress listing itself cannot be fetched (#545)', async () => {
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        throw new GitHubApiError('GitHub request failed with HTTP 500', 500);
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  await assert.rejects(
    () =>
      verifyBrokerConcurrency(api, task, 9001, brokerConcurrencyGroup(task), {
        sleepImpl: async () => {
          throw new Error(
            'a transport failure fetching the listing must not retry',
          );
        },
      }),
    (error) => error.name === 'GitHubApiError',
  );
});

test('findConflictingRouterRun finds another in-progress run carrying the same router-group marker', async () => {
  const marker = routerGroupMarker();
  const requests = [];
  const api = {
    requestOk: async (path) => {
      requests.push(path);
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            // Excluded: this is our own run, even though it carries the
            // marker.
            { id: 9001, display_title: `route #304: manual ${marker}` },
            // No marker at all -- a pre-#545 run, or an unrelated
            // in-progress run; must not match.
            { id: 9010, display_title: 'route #304: labeled agent:claude' },
            // Genuinely carries this task's marker.
            {
              id: 9005,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/jobs')) {
        // Its broker job is genuinely in progress, so it really does hold
        // the group.
        return { jobs: [{ name: 'broker', status: 'in_progress' }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const conflicting = await findConflictingRouterRun(api, task, 9001);
  assert.equal(conflicting.id, 9005);
  // One listing call plus one jobs call for the sole marker-carrying,
  // not-self candidate -- 9001 is excluded as self and 9010 carries no
  // marker at all, so neither's jobs are ever inspected. #545 removed the
  // flaky concurrency_groups fetch entirely; that invariant (never touch
  // it) still holds here, it's simply no longer the reason the request
  // count is what it is.
  assert.deepEqual(requests, [
    '/repos/jlapenna/agent-lcars/actions/workflows/agent-router.yml/runs?status=in_progress&per_page=100',
    '/repos/jlapenna/agent-lcars/actions/runs/9005/jobs?per_page=100',
  ]);
  assert.equal(
    requests.some((path) => path.includes('/concurrency_groups')),
    false,
  );
});

test('findConflictingRouterRun returns undefined when no other in-progress run carries the marker', async () => {
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
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  assert.equal(await findConflictingRouterRun(api, task, 9001), undefined);
});

test('findConflictingRouterRun excludes its own run even when the listing includes it carrying the marker', async () => {
  const marker = routerGroupMarker();
  const api = {
    requestOk: async () => ({
      workflow_runs: [
        { id: 9001, display_title: `route #304: manual ${marker}` },
      ],
    }),
  };
  assert.equal(await findConflictingRouterRun(api, task, 9001), undefined);
});

test('findConflictingRouterRun ignores a run for a different issue even though it carries a router-group marker', async () => {
  const api = {
    requestOk: async () => ({
      workflow_runs: [
        {
          id: 9010,
          display_title: `route #999: unrelated issue ${routerGroupMarker(999)}`,
        },
      ],
    }),
  };
  assert.equal(await findConflictingRouterRun(api, task, 9001), undefined);
});

// #545's whole point: two runs of a trigger type whose OWN
// `concurrency_groups` listing never used to materialize (e.g. two
// workflow_dispatch runs racing for the same group) previously could not
// detect each other at all -- the old indirect check needed run B's own
// listing to confirm B held the group, and that self-report never arrived
// for these trigger types no matter how long a caller waited. Proven closed
// here: from EITHER run's own perspective, the OTHER is visible on the
// single in-progress listing (display_title is returned inline, no
// per-run fetch needed), so each one independently finds the other as a
// conflict.
test('detects two simultaneous same-group runs symmetrically -- the #545 gap', async () => {
  const marker = routerGroupMarker();
  const runA = { id: 9001, display_title: `route #304: manual ${marker}` };
  const runB = { id: 9002, display_title: `route #304: manual ${marker}` };
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return { workflow_runs: [runA, runB] };
      }
      // Both runs' broker jobs are genuinely in progress -- each really
      // does hold the group from the other's point of view.
      return { jobs: [{ name: 'broker', status: 'in_progress' }] };
    },
  };
  const conflictSeenByA = await findConflictingRouterRun(api, task, runA.id);
  const conflictSeenByB = await findConflictingRouterRun(api, task, runB.id);
  assert.equal(conflictSeenByA.id, runB.id);
  assert.equal(conflictSeenByB.id, runA.id);
});

// Regression coverage for the bug a Codex review caught: `run-name:` is
// evaluated at the *workflow* level, so a second run carries this task's
// marker from the instant it starts -- while it is still only in its
// `normalize` job. But `normalize` takes no concurrency group at all; only
// the `broker` job takes the per-task group (see agent-router.yml, whose
// comment records why normalize's old repository-wide queue was removed
// after it was found silently cancelling queued router runs). Treating a
// same-task run
// as a holder purely because the marker is present -- without checking
// which job is actually running -- would manufacture false conflicts during
// ordinary event bursts and, once the retry budget expired, drop or delay
// legitimate intent/completion/control evidence. This had no coverage
// before; the six tests below lock in the job-level check.
test('findConflictingRouterRun does not treat a same-task run still only in its normalize job as a conflict', async () => {
  const marker = routerGroupMarker();
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            {
              id: 9005,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/jobs')) {
        return {
          jobs: [
            { name: 'normalize', status: 'in_progress' },
            { name: 'broker', status: 'queued' },
          ],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  assert.equal(await findConflictingRouterRun(api, task, 9001), undefined);
});

test('findConflictingRouterRun treats a candidate whose broker job is in_progress as a conflict', async () => {
  const marker = routerGroupMarker();
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            {
              id: 9005,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/jobs')) {
        return {
          jobs: [
            { name: 'normalize', status: 'completed' },
            { name: 'broker', status: 'in_progress' },
          ],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const conflicting = await findConflictingRouterRun(api, task, 9001);
  assert.equal(conflicting.id, 9005);
});

test('findConflictingRouterRun does not treat a candidate whose broker job has already completed as a conflict', async () => {
  const marker = routerGroupMarker();
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            {
              id: 9005,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/jobs')) {
        return {
          jobs: [
            { name: 'normalize', status: 'completed' },
            { name: 'broker', status: 'completed' },
          ],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  assert.equal(await findConflictingRouterRun(api, task, 9001), undefined);
});

test("findConflictingRouterRun fails closed (propagates) when a candidate's jobs listing cannot be fetched", async () => {
  const marker = routerGroupMarker();
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            {
              id: 9005,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/jobs')) {
        throw new GitHubApiError('GitHub request failed with HTTP 500', 500);
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  await assert.rejects(
    () => findConflictingRouterRun(api, task, 9001),
    (error) => error.name === 'GitHubApiError',
  );
});

test('findConflictingRouterRun checks multiple candidates in order and only reports the one that actually holds the group', async () => {
  const marker = routerGroupMarker();
  const jobsRequested = [];
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        return {
          workflow_runs: [
            // First candidate: carries the marker, but still only in
            // `normalize` -- not a holder.
            {
              id: 9004,
              display_title: `route #304: labeled agent:claude ${marker}`,
            },
            // Second candidate: genuinely holds the group.
            {
              id: 9005,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9004/jobs')) {
        jobsRequested.push(9004);
        return {
          jobs: [
            { name: 'normalize', status: 'in_progress' },
            { name: 'broker', status: 'queued' },
          ],
        };
      }
      if (path.includes('/actions/runs/9005/jobs')) {
        jobsRequested.push(9005);
        return { jobs: [{ name: 'broker', status: 'in_progress' }] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const conflicting = await findConflictingRouterRun(api, task, 9001);
  assert.equal(conflicting.id, 9005);
  assert.deepEqual(jobsRequested, [9004, 9005]);
});

test('findConflictingRouterRun fails closed (propagates) when the in-progress listing cannot be fetched', async () => {
  const api = {
    requestOk: async (path) => {
      if (
        path.includes('/workflows/agent-router.yml/runs?status=in_progress')
      ) {
        throw new GitHubApiError('GitHub request failed with HTTP 500', 500);
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  await assert.rejects(
    () => findConflictingRouterRun(api, task, 9001),
    (error) => error.name === 'GitHubApiError',
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

test('authority projection repairs duplicate corrupt markers and selects the workflow-owned comment without parsing it', async () => {
  const authoritative = createLedger(task);
  authoritative.control.closed = true;
  const requests = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'DELETE') return response(204);
      return response(200, [
        {
          id: 4,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> corrupt',
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
        {
          id: 2,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> also corrupt',
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
        {
          id: 1,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> attacker',
          user: { login: 'worker', type: 'User' },
        },
      ]);
    },
  });

  const projected = await loadLedgerProjection(api, task, authoritative);

  assert.equal(projected.comment.id, 2);
  assert.equal(projected.ledger, authoritative);
  assert.equal(projected.ledger.control.closed, true);
  assert.equal(
    requests.filter(({ options }) => options.method === 'DELETE').length,
    1,
  );
  assert.match(requests.at(-1).url, /issues\/comments\/4$/u);
});

test('authority projection fails closed when duplicate repair is rejected', async () => {
  const authoritative = createLedger(task);
  const body = renderLedgerComment(authoritative);
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (_url, options) =>
      options.method === 'DELETE'
        ? response(403, { message: 'forbidden' })
        : response(200, [
            {
              id: 2,
              body,
              user: { login: 'github-actions[bot]', type: 'Bot' },
            },
            {
              id: 4,
              body,
              user: { login: 'github-actions[bot]', type: 'Bot' },
            },
          ]),
  });

  await assert.rejects(
    () => loadLedgerProjection(api, task, authoritative),
    /Failed to remove duplicate workflow-owned ledger comment 4: HTTP 403/u,
  );
});

test('authority detects an existing workflow-owned projection without parsing it', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () =>
      response(200, [
        {
          id: 2,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> corrupt',
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
      ]),
  });

  assert.equal(await hasLedgerProjection(api, task), true);
});

test('authority does not treat an unowned marker as an existing projection', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () =>
      response(200, [
        {
          id: 2,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> attacker',
          user: { login: 'worker', type: 'User' },
        },
      ]),
  });

  assert.equal(await hasLedgerProjection(api, task), false);
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

test('listRecentlyClosedAgentLabeledIssues queries all three agent labels and all three review labels with state=closed, deduping by issue number', async () => {
  const seen = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes('labels=agent%3Aclaude')) {
        return response(200, [{ number: 660 }, { number: 622 }]);
      }
      if (url.includes('labels=agent%3Acodex')) {
        // Same issue reported under a second label -- an (invalid)
        // contradictory-label issue must still only be scanned once.
        return response(200, [{ number: 622 }]);
      }
      if (
        url.includes('labels=agent%3Aopencode') ||
        url.includes('labels=review%3Aclaude') ||
        url.includes('labels=review%3Acodex') ||
        url.includes('labels=review%3Aopencode')
      ) {
        return response(200, []);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const issues = await listRecentlyClosedAgentLabeledIssues(
    api,
    task,
    '2026-08-07T00:00:00.000Z',
  );
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [622, 660],
  );
  assert.equal(seen.length, 6);
  for (const url of seen) assert.match(url, /state=closed/u);
});

// The task explicitly warns an unbounded closed-state sweep over the whole
// repository history would be far more expensive than the open sweeps this
// mirrors -- this is the guard against that: every request must carry a
// `since` no older than CLOSED_SWEEP_WINDOW_MS behind the reference time,
// not an open-ended query.
test('listRecentlyClosedAgentLabeledIssues bounds every request with a `since` exactly CLOSED_SWEEP_WINDOW_MS behind the reference time', async () => {
  const now = '2026-08-07T12:00:00.000Z';
  const expectedSince = new Date(
    Date.parse(now) - CLOSED_SWEEP_WINDOW_MS,
  ).toISOString();
  const seen = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      seen.push(url);
      return response(200, []);
    },
  });
  await listRecentlyClosedAgentLabeledIssues(api, task, now);
  assert.equal(seen.length, 6, 'one bounded request per agent/review label');
  for (const url of seen) {
    const since = new URL(url).searchParams.get('since');
    assert.equal(since, expectedSince);
  }
  // 24 hours, not "the repository's whole history" -- see the function's
  // own header comment for why that window was chosen.
  assert.equal(CLOSED_SWEEP_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test('listRecentlyClosedAgentLabeledIssues paginates a single label past 100 results', async () => {
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
  const issues = await listRecentlyClosedAgentLabeledIssues(api, task);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(issues.length, 101);
});

test('listRecentlyClosedIssuesAssignedTo queries the exact assignee login with state=closed and a bounded `since` (#715 review)', async () => {
  const now = '2026-08-07T12:00:00.000Z';
  const expectedSince = new Date(
    Date.parse(now) - CLOSED_SWEEP_WINDOW_MS,
  ).toISOString();
  const seen = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      seen.push(url);
      assert.ok(url.includes('state=closed'));
      assert.ok(url.includes('assignee=jclaw-bot'));
      assert.equal(new URL(url).searchParams.get('since'), expectedSince);
      return response(200, [{ number: 500 }]);
    },
  });
  const issues = await listRecentlyClosedIssuesAssignedTo(
    api,
    task,
    'jclaw-bot',
    now,
  );
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [500],
  );
  assert.equal(seen.length, 1);
});

test('listRecentlyClosedIssuesAssignedTo is a no-op returning no requests when no login is configured', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => {
      throw new Error('must not call the API without a configured login');
    },
  });
  assert.deepEqual(await listRecentlyClosedIssuesAssignedTo(api, task, ''), []);
  assert.deepEqual(
    await listRecentlyClosedIssuesAssignedTo(api, task, undefined),
    [],
  );
});

test('listRecentlyClosedIssuesAssignedTo paginates past 100 results', async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
  }));
  const requestedPages = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requestedPages.push(page);
      return response(200, page === 1 ? pageOne : [{ number: 101 }]);
    },
  });
  const issues = await listRecentlyClosedIssuesAssignedTo(
    api,
    task,
    'jclaw-bot',
  );
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(issues.length, 101);
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
