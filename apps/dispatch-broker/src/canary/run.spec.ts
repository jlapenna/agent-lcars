import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createLedger, LEDGER_MARKER, renderLedgerComment } from '../broker.js';
import { createGitHubApi } from '../github-api.js';
import {
  CANARY_SWEEP_CONCURRENCY,
  closeCanaryIssue,
  dispatchRouterCanary,
  issueBody,
  LEDGER_POLL_TIMEOUT_MS,
  parkCanaryFailure,
  pollCanaryLedger,
  prepareCanaryIssue,
  probeLiveUrl,
  runDispatchCanary,
  STALE_CANARY_AGE_MS,
  sweepStaleCanaries,
} from './run.js';

const CANARY_MARKER = '<!-- agent-lcars:dispatch-canary-canonical:v2 -->';
const LEGACY_CANARY_MARKER = '<!-- agent-lcars:dispatch-canary:v1 -->';

const repository = 'jlapenna/agent-lcars';
const task = { repositoryId: 123, repository, issue: 900 };

function response(status, data) {
  return {
    status,
    headers: new Headers(),
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  };
}

function api(handler) {
  return createGitHubApi({ token: 'token', fetchImpl: handler });
}

function ledgerCommentWithGeneration(options = {}) {
  const {
    state = 'completed',
    status = state === 'completed' ? 'completed' : 'in_progress',
    issue = task.issue,
    user = { login: 'github-actions[bot]', type: 'Bot' },
    sourceId = '11111111-1111-4111-8111-111111111111',
  } = options;
  const conclusion = Object.hasOwn(options, 'conclusion')
    ? options.conclusion
    : 'success';
  const ledger = createLedger({ ...task, issue }, '2026-08-01T00:00:00.000Z');
  const attempt = {
    token: 'dispatch_token_123456',
    runId: 42,
    runUrl: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    status,
    ...(conclusion !== undefined && { conclusion }),
  };
  ledger.generations.push({
    generation: 1,
    intentId: 'intent-1',
    sourceId,
    occurredAt: '2026-08-01T00:00:00.000Z',
    pipeline: 'canary',
    mode: 'implement',
    runbook: '',
    context: '',
    reply: '',
    digest: 'deadbeef',
    state,
    attempt,
  });
  return {
    id: 5,
    body: renderLedgerComment(ledger),
    user,
  };
}

function openIssue({
  number,
  title = '[dispatch-canary] Production dispatch broker canary — x',
  body = `stub\n\n${CANARY_MARKER}`,
  createdAt = '2026-08-01T00:00:00.000Z',
  updatedAt = createdAt,
  labels = [],
} = {}) {
  return {
    number,
    title,
    body,
    created_at: createdAt,
    updated_at: updatedAt,
    labels,
  };
}

test('issueBody includes the canary marker, source, and both run links', () => {
  const body = issueBody({
    source: 'scheduled',
    runUrl: 'https://example.test/run/1',
    deployRunUrl: 'https://example.test/deploy/1',
  });
  assert.match(body, /<!-- agent-lcars:dispatch-canary-canonical:v2 -->/u);
  assert.match(body, /Source: scheduled/u);
  assert.match(body, /Orchestrator run: https:\/\/example\.test\/run\/1/u);
  assert.match(body, /Deploy run: https:\/\/example\.test\/deploy\/1/u);
});

test('prepareCanaryIssue creates the canonical marked issue once', async () => {
  let request;
  const client = api(async (url, options) => {
    if (url.includes('/issues?state=all')) return response(200, []);
    request = { url, options };
    return response(201, { number: 900 });
  });
  const issue = await prepareCanaryIssue(client, repository, {
    source: 'scheduled',
    runUrl: 'https://example.test/run/1',
  });
  assert.equal(issue.number, 900);
  assert.equal(request.options.method, 'POST');
  assert.match(request.url, /\/repos\/jlapenna\/agent-lcars\/issues$/u);
  const body = JSON.parse(request.options.body);
  assert.match(body.title, /^\[dispatch-canary\]/u);
  assert.match(body.body, /agent-lcars:dispatch-canary-canonical:v2/u);
});

test('prepareCanaryIssue fails loud when GitHub omits the issue number', async () => {
  const client = api(async (url) =>
    url.includes('/issues?state=all') ? response(200, []) : response(201, {}),
  );
  await assert.rejects(
    () =>
      prepareCanaryIssue(client, repository, {
        source: 'scheduled',
        runUrl: 'x',
      }),
    /did not return the canonical canary issue number/u,
  );
});

test('prepareCanaryIssue reopens and refreshes the one existing canonical issue instead of creating another', async () => {
  const calls = [];
  const existing = openIssue({ number: 677 });
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/issues?state=all')) return response(200, [existing]);
    return response(200, { number: 677 });
  });
  const issue = await prepareCanaryIssue(client, repository, {
    source: 'post-deploy',
    runUrl: 'https://example.test/run/2',
  });
  assert.equal(issue.number, 677);
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.endsWith('/issues'),
    ),
    false,
  );
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.ok(patch);
  assert.deepEqual(JSON.parse(patch.body), {
    title: '[dispatch-canary] Production dispatch broker canary',
    body: issueBody({
      source: 'post-deploy',
      runUrl: 'https://example.test/run/2',
    }),
    state: 'open',
  });
});

test('prepareCanaryIssue fails closed on duplicate canonical markers', async () => {
  const client = api(async () =>
    response(200, [openIssue({ number: 677 }), openIssue({ number: 900 })]),
  );
  await assert.rejects(
    () =>
      prepareCanaryIssue(client, repository, {
        source: 'scheduled',
        runUrl: 'x',
      }),
    /Duplicate canonical dispatch canary issues: #677, #900/u,
  );
});

test('dispatchRouterCanary fires kind=canary with the exact issue and stable caller identity', async () => {
  let request;
  const client = api(async (url, options) => {
    request = { url, options };
    return response(200, {
      workflow_run_id: 7,
      run_url:
        'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/7',
      html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/7',
    });
  });
  const callerId = '11111111-1111-4111-8111-111111111111';
  await dispatchRouterCanary(client, repository, 900, callerId);
  assert.match(request.url, /agent-router\.yml\/dispatches$/u);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.inputs, {
    kind: 'canary',
    issue: '900',
    caller_id: callerId,
  });
});

test('pollCanaryLedger resolves once the canary generation reaches completed/success', async () => {
  let call = 0;
  const client = api(async () => {
    call += 1;
    if (call < 3) return response(200, []);
    return response(200, [ledgerCommentWithGeneration()]);
  });
  let clock = 0;
  const result = await pollCanaryLedger(client, task, {
    now: () => clock,
    sleepImpl: async () => {
      clock += 1_000;
    },
  });
  assert.equal(result.generation.state, 'completed');
  assert.equal(result.generation.attempt.conclusion, 'success');
  assert.equal(call, 3);
});

test('pollCanaryLedger logs only meaningful caller-specific state transitions with elapsed time', async () => {
  let call = 0;
  const client = api(async () => {
    call += 1;
    if (call === 1) return response(200, []);
    if (call === 2) {
      return response(200, [
        ledgerCommentWithGeneration({
          state: 'dispatched',
          conclusion: undefined,
        }),
      ]);
    }
    return response(200, [ledgerCommentWithGeneration()]);
  });
  let clock = 0;
  const notices = [];
  await pollCanaryLedger(client, task, {
    now: () => clock,
    sleepImpl: async (delay) => {
      clock += delay;
    },
    log: (message) => notices.push(message),
  });
  assert.equal(notices.length, 3);
  assert.match(notices[0], /after 0s: awaiting a ledger generation/u);
  assert.match(notices[1], /after 2s: g1 state=dispatched/u);
  assert.match(notices[1], /worker=https:\/\/github\.com\/jlapenna/u);
  assert.match(notices[2], /after 6s: g1 state=completed/u);
});

test('pollCanaryLedger waits for this orchestrator caller instead of accepting an older successful generation', async () => {
  const current = '22222222-2222-4222-8222-222222222222';
  let call = 0;
  const client = api(async () => {
    call += 1;
    return response(200, [
      ledgerCommentWithGeneration({
        sourceId: call === 1 ? '11111111-1111-4111-8111-111111111111' : current,
      }),
    ]);
  });
  let clock = 0;
  const result = await pollCanaryLedger(client, task, {
    sourceId: current,
    now: () => clock,
    sleepImpl: async () => {
      clock += 1_000;
    },
  });
  assert.equal(call, 2);
  assert.equal(result.generation.sourceId, current);
});

test('pollCanaryLedger reports a rejected dispatch as a terminal, non-timeout outcome', async () => {
  const client = api(async () =>
    response(200, [
      ledgerCommentWithGeneration({
        state: 'dispatch-rejected',
        conclusion: undefined,
      }),
    ]),
  );
  let clock = 0;
  const result = await pollCanaryLedger(client, task, {
    now: () => clock,
    sleepImpl: async () => {
      clock += 1_000;
    },
  });
  assert.equal(result.rejected, true);
});

test('pollCanaryLedger times out loudly rather than polling forever', async () => {
  const client = api(async () => response(200, []));
  let clock = 0;
  await assert.rejects(
    () =>
      pollCanaryLedger(client, task, {
        timeoutMs: 5_000,
        now: () => clock,
        sleepImpl: async () => {
          clock += 10_000;
        },
      }),
    /Timed out waiting.*after 10s; last observation: awaiting a ledger generation/su,
  );
});

test('the production timeout contract covers the observed 26-minute lifecycle and preserves ten minutes of job cleanup headroom (#772)', async () => {
  assert.equal(LEDGER_POLL_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(STALE_CANARY_AGE_MS, 40 * 60 * 1000);
  assert.equal(STALE_CANARY_AGE_MS - LEDGER_POLL_TIMEOUT_MS, 10 * 60 * 1000);

  const client = api(async () => response(200, []));
  let clock = 0;
  await assert.rejects(
    () =>
      pollCanaryLedger(client, task, {
        now: () => clock,
        sleepImpl: async (delay) => {
          clock += delay;
        },
        log: () => undefined,
      }),
    /after 1800s/u,
  );
  assert.equal(
    clock,
    LEDGER_POLL_TIMEOUT_MS,
    'backoff must stop at the configured deadline rather than overshooting it',
  );
});

test('pollCanaryLedger rejects a spoofed non-bot-authored comment claiming success, never accepting it as the real ledger (P1)', async () => {
  const spoofed = ledgerCommentWithGeneration({
    user: { login: 'attacker', type: 'User' },
  });
  const client = api(async () => response(200, [spoofed]));
  let clock = 0;
  await assert.rejects(
    () =>
      pollCanaryLedger(client, task, {
        now: () => clock,
        sleepImpl: async () => {
          clock += 1_000;
        },
      }),
    /Dispatch ledger author is not the workflow identity/u,
  );
});

test('pollCanaryLedger rejects an App-bot-shaped but wrong-login spoofed comment too, not just non-bot users', async () => {
  const spoofed = ledgerCommentWithGeneration({
    user: { login: 'some-other-app[bot]', type: 'Bot' },
  });
  const client = api(async () => response(200, [spoofed]));
  let clock = 0;
  await assert.rejects(
    () =>
      pollCanaryLedger(client, task, {
        now: () => clock,
        sleepImpl: async () => {
          clock += 1_000;
        },
      }),
    /Dispatch ledger author is not the workflow identity/u,
  );
});

test('pollCanaryLedger fails closed on duplicate marker-bearing comments rather than trusting the first', async () => {
  const spoofed = ledgerCommentWithGeneration({
    user: { login: 'attacker', type: 'User' },
  });
  const real = ledgerCommentWithGeneration();
  const client = api(async () => response(200, [spoofed, real]));
  let clock = 0;
  await assert.rejects(
    () =>
      pollCanaryLedger(client, task, {
        now: () => clock,
        sleepImpl: async () => {
          clock += 1_000;
        },
      }),
    /Duplicate dispatch ledger comments/u,
  );
});

test('closeCanaryIssue comments success evidence, then closes the issue', async () => {
  const calls = [];
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    return response(200, {});
  });
  await closeCanaryIssue(client, task, {
    generation: { generation: 1, attempt: { htmlUrl: 'https://x/run/42' } },
    runUrl: 'https://example.test/run/1',
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/comments$/u);
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].url, /\/issues\/900$/u);
  assert.equal(calls[2].method, 'DELETE');
  assert.match(calls[2].url, /\/labels\/status%3Aneeds-human$/u);
});

test('closeCanaryIssue treats an already-cleared blocker label as idempotent', async () => {
  const calls = [];
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method });
    return url.includes('/labels/') && options.method === 'DELETE'
      ? response(404, { message: 'Label does not exist' })
      : response(200, {});
  });
  await closeCanaryIssue(client, task, {
    generation: { generation: 2 },
    runUrl: 'https://example.test/run/2',
  });
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('parkCanaryFailure leaves the issue open with a comment plus status:needs-human label and assignee', async () => {
  const calls = [];
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    return response(200, {});
  });
  await parkCanaryFailure(client, task, 'jlapenna', 'boom');
  const bodies = calls.map((call) => call.body && JSON.parse(call.body));
  assert.ok(bodies.some((body) => body?.body?.includes('boom')));
  assert.ok(bodies.some((body) => Array.isArray(body?.labels)));
  assert.ok(
    bodies.some(
      (body) =>
        Array.isArray(body?.assignees) && body.assignees.includes('jlapenna'),
    ),
  );
  assert.ok(calls.every((call) => call.url.includes('/issues/900')));
  assert.deepEqual(bodies[0], { state: 'open' });
});

test('probeLiveUrl retries transient failures before succeeding', async () => {
  let attempts = 0;
  const result = await probeLiveUrl('https://example.test/', {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 2) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    },
    maxAttempts: 5,
    sleepImpl: async () => undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
});

test('probeLiveUrl exhausts its bounded attempts and reports the last failure reason', async () => {
  const result = await probeLiveUrl('https://example.test/', {
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
    maxAttempts: 3,
    sleepImpl: async () => undefined,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /connection refused/u);
});

test('runDispatchCanary end to end: create, dispatch, poll to success, close', async () => {
  const calls = [];
  let pollCall = 0;
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/issues?state=all')) return response(200, []);
    if (options.method === 'POST' && url.endsWith('/issues')) {
      return response(201, { number: 901 });
    }
    if (url.includes('/dispatches')) {
      return response(200, {
        workflow_run_id: 7,
        run_url:
          'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/7',
        html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/7',
      });
    }
    if (url.includes('/issues/901/comments') && options.method === 'GET') {
      pollCall += 1;
      return response(
        200,
        pollCall < 2 ? [] : [ledgerCommentWithGeneration({ issue: 901 })],
      );
    }
    return response(200, {});
  });
  let clock = 0;
  const result = await runDispatchCanary({
    api: client,
    repository,
    repositoryId: 123,
    maintainer: 'jlapenna',
    source: 'scheduled',
    runUrl: 'https://example.test/run/1',
    callerId: '11111111-1111-4111-8111-111111111111',
    pollOptions: {
      now: () => clock,
      sleepImpl: async () => {
        clock += 1_000;
      },
    },
  });
  assert.equal(result.issue, 901);
  const patched = calls.find((call) => call.method === 'PATCH');
  assert.ok(patched, 'expected the issue to be closed');
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.includes('/labels'),
    ),
    false,
    'a successful run must never park status:needs-human',
  );
});

test('runDispatchCanary parks status:needs-human and rethrows when the ledger never completes', async () => {
  const calls = [];
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/issues?state=all')) return response(200, []);
    if (options.method === 'POST' && url.endsWith('/issues')) {
      return response(201, { number: 902 });
    }
    if (url.includes('/dispatches')) {
      return response(200, {
        workflow_run_id: 7,
        run_url:
          'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/7',
        html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/7',
      });
    }
    if (url.includes('/issues/902/comments') && options.method === 'GET') {
      return response(200, []);
    }
    return response(200, {});
  });
  let clock = 0;
  await assert.rejects(
    () =>
      runDispatchCanary({
        api: client,
        repository,
        repositoryId: 123,
        maintainer: 'jlapenna',
        source: 'scheduled',
        runUrl: 'https://example.test/run/1',
        callerId: '11111111-1111-4111-8111-111111111111',
        pollOptions: {
          timeoutMs: 5_000,
          now: () => clock,
          sleepImpl: async () => {
            clock += 10_000;
          },
        },
      }),
    /Timed out waiting/u,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.body &&
        JSON.parse(call.body).state === 'closed',
    ),
    false,
    'a failed run must never close the issue',
  );
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.includes('/labels'),
    ),
    true,
    'a failed run must park status:needs-human',
  );
});

test('runDispatchCanary skips the broker entirely and parks when the live URL probe fails', async () => {
  const calls = [];
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/issues?state=all')) return response(200, []);
    if (options.method === 'POST' && url.endsWith('/issues')) {
      return response(201, { number: 903 });
    }
    return response(200, {});
  });
  await assert.rejects(
    () =>
      runDispatchCanary({
        api: client,
        repository,
        repositoryId: 123,
        maintainer: 'jlapenna',
        source: 'post-deploy',
        runUrl: 'https://example.test/run/1',
        callerId: '11111111-1111-4111-8111-111111111111',
        liveUrl: 'https://agent-console.example/',
        probeOptions: {
          fetchImpl: async () => ({ ok: false, status: 500 }),
          maxAttempts: 1,
          sleepImpl: async () => undefined,
        },
      }),
    /Post-deploy smoke: Live URL probe failed/u,
  );
  assert.equal(
    calls.some((call) => call.url.includes('/dispatches')),
    false,
    'a broken deploy must never trigger a broker dispatch',
  );
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.includes('/labels'),
    ),
    true,
    'a live URL probe failure must still park status:needs-human on a created issue',
  );
});

test('sweepStaleCanaries closes a stale issue whose ledger already shows a successful canary completion', async () => {
  const calls = [];
  const issue = openIssue({
    number: 950,
    body: `legacy artifact\n\n${LEGACY_CANARY_MARKER}`,
  });
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.includes('/issues?state=open')) return response(200, [issue]);
    if (
      url.includes('/issues/950/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, [ledgerCommentWithGeneration({ issue: 950 })]);
    }
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.deepEqual(swept, [{ issue: 950, outcome: 'closed' }]);
  assert.ok(
    calls.some((call) => call.method === 'PATCH'),
    'expected the stale issue to be closed',
  );
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.includes('/labels'),
    ),
    false,
    'a successfully-completed canary must never be parked',
  );
});

test('sweepStaleCanaries parks status:needs-human for a stale issue whose ledger never completed', async () => {
  const calls = [];
  const issue = openIssue({ number: 951 });
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/issues?state=open')) return response(200, [issue]);
    if (
      url.includes('/issues/951/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, []);
    }
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.deepEqual(swept, [{ issue: 951, outcome: 'parked' }]);
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.includes('/labels'),
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.body &&
        JSON.parse(call.body).state === 'closed',
    ),
    false,
    'an unverified stale canary must never be closed',
  );
});

test('sweepStaleCanaries never touches an issue younger than the staleness threshold', async () => {
  const issue = openIssue({
    number: 952,
    createdAt: '2026-08-01T00:50:00.000Z',
  });
  let touchedBeyondListing = false;
  const client = api(async (url) => {
    if (url.includes('/issues?state=open')) return response(200, [issue]);
    touchedBeyondListing = true;
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z'); // 10 minutes old
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.deepEqual(swept, []);
  assert.equal(touchedBeyondListing, false);
});

test('sweepStaleCanaries leaves an already-parked stale issue alone (no duplicate park comment/label/assignee) while its ledger is still unresolved (#527)', async () => {
  const calls = [];
  const issue = openIssue({ number: 953, labels: ['status:needs-human'] });
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.includes('/issues?state=open')) return response(200, [issue]);
    if (
      url.includes('/issues/953/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, []);
    }
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.deepEqual(swept, [{ issue: 953, outcome: 'already-parked' }]);
  assert.equal(
    calls.some((call) => call.method === 'POST'),
    false,
    'an already-parked, still-unresolved canary must never be re-parked or re-commented',
  );
  assert.equal(
    calls.some((call) => call.method === 'PATCH'),
    false,
  );
});

test('sweepStaleCanaries recovers and closes an already-parked stale issue once its ledger shows a late successful completion (#527)', async () => {
  const calls = [];
  const issue = openIssue({ number: 953, labels: ['status:needs-human'] });
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.includes('/issues?state=open')) return response(200, [issue]);
    if (
      url.includes('/issues/953/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, [ledgerCommentWithGeneration({ issue: 953 })]);
    }
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.deepEqual(swept, [
    { issue: 953, outcome: 'closed-after-late-success' },
  ]);
  assert.ok(
    calls.some((call) => call.method === 'PATCH'),
    'expected the recovered issue to be closed',
  );
  assert.equal(
    calls.some(
      (call) => call.method === 'POST' && call.url.includes('/labels'),
    ),
    false,
    'a recovered canary must never be re-parked',
  );
});

test('sweepStaleCanaries ignores open issues that are not its own marked canary', async () => {
  const unrelated = openIssue({
    number: 954,
    title: 'Some unrelated bug report',
    body: 'no canary marker in here',
  });
  let touchedBeyondListing = false;
  const client = api(async (url) => {
    if (url.includes('/issues?state=open')) return response(200, [unrelated]);
    touchedBeyondListing = true;
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.deepEqual(swept, []);
  assert.equal(touchedBeyondListing, false);
});

test('sweepStaleCanaries records a per-issue failure without blocking the remaining candidates', async () => {
  const failing = openIssue({ number: 955 });
  const healthy = openIssue({ number: 956 });
  const client = api(async (url, options) => {
    if (url.includes('/issues?state=open'))
      return response(200, [failing, healthy]);
    if (
      url.includes('/issues/955/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      throw new Error('network blip');
    }
    if (
      url.includes('/issues/956/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, []);
    }
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.equal(swept.length, 2);
  assert.equal(swept[0].issue, 955);
  assert.equal(swept[0].outcome, 'error');
  assert.match(swept[0].error, /network blip/u);
  assert.deepEqual(swept[1], { issue: 956, outcome: 'parked' });
});

test('sweepStaleCanaries never closes a stale issue on the strength of a spoofed non-bot ledger comment (P1)', async () => {
  const calls = [];
  const issue = openIssue({ number: 957 });
  const spoofed = ledgerCommentWithGeneration({
    issue: 957,
    user: { login: 'attacker', type: 'User' },
  });
  const client = api(async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.includes('/issues?state=open')) return response(200, [issue]);
    if (
      url.includes('/issues/957/comments') &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, [spoofed]);
    }
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].issue, 957);
  assert.equal(swept[0].outcome, 'error');
  assert.match(swept[0].error, /workflow identity/u);
  assert.equal(
    calls.some((call) => call.method === 'PATCH'),
    false,
    'a spoofed ledger comment must never cause the janitor to close the issue',
  );
});

// PR #374 review (P2): the same unbounded-burst risk flagged for
// dispatchReconcileScan applies here too -- a "list every open issue"
// discovery pass can turn up a large stale backlog, and firing every
// issue's cleanup (comment + label + assignee mutations) at once would
// risk tripping GitHub's secondary rate limits.
test('sweepStaleCanaries bounds concurrent per-issue cleanup to CANARY_SWEEP_CONCURRENCY while still sweeping every stale issue', async () => {
  const total = CANARY_SWEEP_CONCURRENCY * 3 + 1;
  const issues = Array.from({ length: total }, (_, index) =>
    openIssue({ number: 2000 + index }),
  );
  let active = 0;
  let maxActive = 0;
  const client = api(async (url, options) => {
    if (url.includes('/issues?state=open')) {
      return response(200, issues);
    }
    // Every other call is one sequential step of a single issue's cleanup
    // (comments GET via loadLedger, then comment/label/assignee POSTs) --
    // since steps within one issue are sequential (awaited one at a time),
    // the number of these simultaneously in flight across all issues
    // reflects exactly how many pool slots are active at once.
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if ((options.method ?? 'GET') === 'GET') return response(200, []);
    return response(200, {});
  });
  const clock = Date.parse('2026-08-01T01:00:00.000Z');
  const swept = await sweepStaleCanaries(client, repository, 123, 'jlapenna', {
    now: () => clock,
  });
  assert.equal(swept.length, total);
  assert.ok(swept.every((entry) => entry.outcome === 'parked'));
  assert.equal(active, 0, 'every in-flight request must have finished');
  assert.ok(
    maxActive <= CANARY_SWEEP_CONCURRENCY,
    `expected at most ${CANARY_SWEEP_CONCURRENCY} concurrent in-flight requests, saw ${maxActive}`,
  );
  assert.equal(
    maxActive,
    CANARY_SWEEP_CONCURRENCY,
    'expected the pool to actually reach its concurrency limit given a backlog larger than it',
  );
});

test('the canary ledger comment marker matches the real broker ledger marker', () => {
  assert.equal(LEDGER_MARKER, '<!-- agent-lcars:dispatch-ledger:v1 -->');
});
