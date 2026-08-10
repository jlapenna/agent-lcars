import assert from 'node:assert/strict';

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
  classifyAuthorityTaskInitialization,
  createGitHubApi,
  ensureLaneReadinessAlert,
  ensureNeedsHumanParked,
  failClosed,
  findRunsForGeneration,
  GitHubApiError,
  loadLedger,
  loadLedgerProjection,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  readLaneReadiness,
  removeIssueLabel,
  resolveLaneReadinessAlerts,
  validateDispatchResponse,
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

test('worker pipeline resolves to exactly one worker workflow file', () => {
  assert.deepEqual(agentWorkerPipelines, ['claude', 'codex', 'opencode']);
  assert.equal(workerWorkflow('claude'), 'claude.yml');
  assert.equal(workerWorkflow('codex'), 'codex.yml');
  assert.equal(workerWorkflow('opencode'), 'opencode.yml');
  assert.throws(
    () => workerWorkflow('not-a-real-pipeline'),
    /Unsupported worker pipeline/u,
  );
});

test('lane readiness maps only the durable health incidents that apply to the selected agent', async () => {
  const issues = [
    {
      number: 803,
      title: 'Codex agent lane is unavailable',
      body: '<!-- agent-lcars:lane-readiness:v1:codex -->',
      html_url: 'https://github.com/jlapenna/agent-lcars/issues/803',
    },
    {
      number: 804,
      title: 'Unrelated PR',
      body: '<!-- agent-lcars:lane-readiness:v1:codex -->',
      pull_request: {},
    },
  ];
  const api = { requestOk: async () => issues };

  assert.deepEqual(
    (await readLaneReadiness(api, task, 'codex')).map((item) => item.issue),
    [803],
  );
  assert.deepEqual(await readLaneReadiness(api, task, 'opencode'), []);
});

test('a proven shared startup failure creates one actionable lane incident and reuses it on redelivery', async () => {
  const calls = [];
  let openIssues = [];
  const api = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.includes('/issues?state=open')) return openIssues;
      if (path.endsWith('/issues') && options.method === 'POST') {
        openIssues = [
          {
            number: 850,
            title: options.body.title,
            body: options.body.body,
            html_url: 'https://github.com/jlapenna/agent-lcars/issues/850',
          },
        ];
        return openIssues[0];
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };

  const first = await ensureLaneReadinessAlert(
    api,
    task,
    'codex',
    'credential',
    'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    'jlapenna',
  );
  const second = await ensureLaneReadinessAlert(
    api,
    task,
    'codex',
    'credential',
    'https://github.com/jlapenna/agent-lcars/actions/runs/43',
    'jlapenna',
  );

  assert.equal(first.number, 850);
  assert.equal(second.number, 850);
  const creates = calls.filter(
    (call) => call.path.endsWith('/issues') && call.options.method === 'POST',
  );
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].options.body.labels, ['status:needs-human']);
  assert.deepEqual(creates[0].options.body.assignees, ['jlapenna']);
  assert.match(creates[0].options.body.body, /repair or rotate/u);
  assert.match(
    creates[0].options.body.body,
    /agent-lcars:lane-readiness:v1:codex/u,
  );
});

test('a trusted recovery probe closes every matching lane incident once and records its exact run', async () => {
  const probeRun = 'https://github.com/jlapenna/agent-lcars/actions/runs/99';
  const openIssues = [
    {
      number: 850,
      title: 'Claude agent lane is unavailable',
      body: '<!-- agent-lcars:lane-readiness:v1:claude -->\n\nFirst failure',
      state: 'open',
    },
    {
      number: 851,
      title: 'Duplicate Claude lane incident',
      body: '<!-- agent-lcars:lane-readiness:v1:claude -->\n\nDuplicate',
      state: 'open',
    },
    {
      number: 852,
      title: 'Codex agent lane is unavailable',
      body: '<!-- agent-lcars:lane-readiness:v1:codex -->',
      state: 'open',
    },
  ];
  const calls = [];
  const api = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.includes('/issues?state=open')) {
        return openIssues.filter((issue) => issue.state === 'open');
      }
      const match = path.match(/\/issues\/(\d+)$/u);
      if (!match) throw new Error(`Unexpected request: ${path}`);
      const issue = openIssues.find(
        (candidate) => candidate.number === Number(match[1]),
      );
      if (!issue) throw new Error(`Unknown readiness issue: ${path}`);
      if (options.method === 'PATCH') {
        Object.assign(issue, options.body);
      }
      return issue;
    },
  };

  const resolved = await resolveLaneReadinessAlerts(
    api,
    task,
    'claude',
    probeRun,
  );
  const redelivery = await resolveLaneReadinessAlerts(
    api,
    task,
    'claude',
    probeRun,
  );

  assert.deepEqual(
    resolved.map((issue) => issue.number),
    [850, 851],
  );
  assert.deepEqual(redelivery, []);
  const patches = calls.filter((call) => call.options.method === 'PATCH');
  assert.equal(patches.length, 2);
  for (const patch of patches) {
    assert.equal(patch.options.body.state, 'closed');
    assert.equal(patch.options.body.state_reason, 'completed');
    assert.match(patch.options.body.body, /Verified recovery probe/u);
    assert.match(patch.options.body.body, /actions\/runs\/99/u);
  }
  assert.equal(openIssues[2].state, 'open');
});

test('a recovery mutation error is accepted only when both closure and exact evidence landed', async () => {
  const issue = {
    number: 850,
    body: '<!-- agent-lcars:lane-readiness:v1:claude -->',
    state: 'open',
  };
  const api = {
    requestOk: async (path, options = {}) => {
      if (path.includes('/issues?state=open')) return [issue];
      if (options.method === 'PATCH') {
        issue.state = 'closed';
        throw new Error('connection reset after partial mutation');
      }
      return issue;
    },
  };

  await assert.rejects(
    resolveLaneReadinessAlerts(
      api,
      task,
      'claude',
      'https://github.com/jlapenna/agent-lcars/actions/runs/99',
    ),
    /connection reset after partial mutation/u,
  );
});

test('a recovery mutation transport error is idempotent when closure and evidence both landed', async () => {
  const issue = {
    number: 850,
    body: '<!-- agent-lcars:lane-readiness:v1:claude -->',
    state: 'open',
  };
  const api = {
    requestOk: async (path, options = {}) => {
      if (path.includes('/issues?state=open')) return [issue];
      if (options.method === 'PATCH') {
        Object.assign(issue, options.body);
        throw new Error('connection reset after complete mutation');
      }
      return issue;
    },
  };

  const resolved = await resolveLaneReadinessAlerts(
    api,
    task,
    'claude',
    'https://github.com/jlapenna/agent-lcars/actions/runs/99',
  );
  assert.deepEqual(
    resolved.map((candidate) => candidate.number),
    [850],
  );
  assert.equal(issue.state, 'closed');
  assert.match(issue.body, /Verified recovery probe/u);
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

test('authority projection repairs every extra corrupt marker and selects the workflow-owned comment without parsing it', async () => {
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
    2,
  );
  assert.deepEqual(
    requests
      .filter(({ options }) => options.method === 'DELETE')
      .map(({ url }) => Number(url.split('/').at(-1)))
      .sort((left, right) => left - right),
    [1, 4],
  );
});

test('authority projection recognizes both Action and hosted controller identities during migration', async () => {
  const authoritative = createLedger(task);
  const deleted = [];
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async (url, options) => {
      if (options.method === 'DELETE') {
        deleted.push(Number(url.split('/').at(-1)));
        return response(204);
      }
      return response(200, [
        {
          id: 4,
          body: renderLedgerComment(authoritative),
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
        {
          id: 2,
          body: renderLedgerComment(authoritative),
          user: { login: 'jlapenna', type: 'User' },
        },
        {
          id: 1,
          body: renderLedgerComment(authoritative),
          user: { login: 'worker', type: 'User' },
        },
      ]);
    },
  });

  const projected = await loadLedgerProjection(api, task, authoritative, [
    { login: 'github-actions[bot]', type: 'Bot' },
    { login: 'jlapenna', type: 'User' },
  ]);

  assert.equal(projected.comment.id, 2);
  assert.deepEqual(
    deleted.sort((left, right) => left - right),
    [1, 4],
  );
});

test('authority projection reports when duplicate repair is rejected', async () => {
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
    /Failed to remove extra dispatch-ledger marker comment 4: HTTP 403/u,
  );
});

test('authority creates its canonical projection and removes an App-bot marker', async () => {
  const authoritative = createLedger(task);
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
      if (options.method === 'DELETE') return response(204);
      return response(200, [
        {
          id: 2,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> app marker',
          user: { login: 'agent-lcars[bot]', type: 'Bot' },
        },
      ]);
    },
  });

  const projected = await loadLedgerProjection(api, task, authoritative);

  assert.equal(projected.comment.id, 9);
  assert.equal(projected.created, true);
  assert.deepEqual(
    requests.map(({ options }) => options.method ?? 'GET'),
    ['GET', 'POST', 'DELETE'],
  );
});

test('authority refuses to initialize over an existing workflow-owned projection', async () => {
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

  assert.equal(
    await classifyAuthorityTaskInitialization(api, task),
    'compatibility-projection',
  );
});

test('authority refuses to initialize over a hosted controller projection', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () =>
      response(200, [
        {
          id: 2,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> hosted',
          user: { login: 'jlapenna', type: 'User' },
        },
      ]),
  });

  assert.equal(
    await classifyAuthorityTaskInitialization(api, task, [
      { login: 'github-actions[bot]', type: 'Bot' },
      { login: 'jlapenna', type: 'User' },
    ]),
    'compatibility-projection',
  );
});

test('authority treats an unowned marker as untracked, regardless of task age', async () => {
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

  assert.equal(
    await classifyAuthorityTaskInitialization(api, task),
    'untracked',
  );
});

test('authority does not trust an App-bot marker as controller projection evidence', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () =>
      response(200, [
        {
          id: 2,
          body: '<!-- agent-lcars:dispatch-ledger:v1 --> app marker',
          user: { login: 'agent-lcars[bot]', type: 'Bot' },
        },
      ]),
  });

  assert.equal(
    await classifyAuthorityTaskInitialization(api, task),
    'untracked',
  );
});

test('authority treats a task with no comments at all as untracked', async () => {
  const api = createGitHubApi({
    token: 'token',
    fetchImpl: async () => response(200, []),
  });

  assert.equal(
    await classifyAuthorityTaskInitialization(api, task),
    'untracked',
  );
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
// bounded fan-out helper. Assert it (a) never lets more than `limit` workers run at
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
