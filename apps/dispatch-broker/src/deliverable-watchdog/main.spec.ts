import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  WATCHDOG_ATTENTION_STATE,
  WATCHDOG_RECOVERED_STATE,
  watchdogMarker,
} from './detect.js';
import { scanDeliverables } from './main.js';

const REPO = 'jlapenna/agent-lcars';
const ROOT = `/repos/${REPO}`;
const NOW = new Date('2026-08-02T00:00:00Z');

function prNode(overrides = {}) {
  return {
    number: 666,
    url: `https://github.com/${REPO}/pull/666`,
    createdAt: '2026-08-01T00:00:00Z',
    isDraft: false,
    headRefOid: 'sha-666',
    author: { login: 'app/agent-lcars' },
    commits: {
      nodes: [{ commit: { committedDate: '2026-08-01T01:00:00Z' } }],
    },
    closingIssuesReferences: {
      totalCount: 1,
      nodes: [{ number: 660, state: 'OPEN' }],
    },
    ...overrides,
  };
}

function graphqlResponse(nodes) {
  return {
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    },
  };
}

function check(overrides = {}) {
  return {
    id: 10,
    name: 'Verify',
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-08-01T01:01:00Z',
    completed_at: '2026-08-01T01:10:00Z',
    html_url: `https://github.com/${REPO}/actions/runs/10`,
    ...overrides,
  };
}

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
      if (!route) throw new Error(`No fake route for ${method} ${basePath}`);
      if (route.error) throw route.error;
      return typeof route.data === 'function'
        ? route.data({ path, options })
        : route.data;
    },
  };
}

function baseRoutes({
  nodes = [prNode()],
  checks = [check()],
  comments = [],
  issue = { labels: [], assignees: [] },
} = {}) {
  return [
    { path: '/graphql', method: 'POST', data: graphqlResponse(nodes) },
    {
      path: `${ROOT}/commits/sha-666/check-runs`,
      data: { check_runs: checks },
    },
    { path: `${ROOT}/issues/660/comments`, data: comments },
    { path: `${ROOT}/issues/660`, data: issue },
  ];
}

async function scan(api) {
  return scanDeliverables({
    api,
    repository: REPO,
    agentBotLogins: new Set(['agent-lcars[bot]', 'claude[bot]']),
    maintainer: 'jlapenna',
    staleHours: 6,
    now: NOW,
  });
}

test('parks and reports a stale agent deliverable on its real open anchor without touching the PR', async () => {
  const routes = baseRoutes();
  routes.push(
    { path: `${ROOT}/issues/660/comments`, method: 'POST', data: {} },
    { path: `${ROOT}/issues/660/labels`, method: 'POST', data: {} },
    { path: `${ROOT}/issues/660/assignees`, method: 'POST', data: {} },
  );
  const api = fakeApi(routes);

  const result = await scan(api);

  assert.deepEqual(result, {
    scanned: 1,
    agentPullRequests: 1,
    needsAttention: 1,
    recovered: 0,
    failed: [],
  });
  const commentCall = api.calls.find(
    (call) =>
      call.basePath === `${ROOT}/issues/660/comments` && call.method === 'POST',
  );
  assert.ok(commentCall);
  assert.match(commentCall.body.body, new RegExp(watchdogMarker(666), 'u'));
  assert.match(commentCall.body.body, /never rebases or merges/u);
  assert.deepEqual(
    api.calls.find((call) => call.basePath.endsWith('/labels'))?.body,
    { labels: ['status:needs-human'] },
  );
  assert.deepEqual(
    api.calls.find((call) => call.basePath.endsWith('/assignees'))?.body,
    { assignees: ['jlapenna'] },
  );
  assert.equal(
    api.calls.some((call) => call.basePath.includes('/pulls/')),
    false,
    'the watchdog must never mutate or merge a pull request',
  );
});

test('an existing active marker with the required label and assignee is idempotent', async () => {
  const api = fakeApi(
    baseRoutes({
      comments: [
        {
          id: 50,
          user: { login: 'github-actions[bot]' },
          body: `${watchdogMarker(666)}\n${WATCHDOG_ATTENTION_STATE}`,
        },
      ],
      issue: {
        labels: [{ name: 'status:needs-human' }],
        assignees: [{ login: 'jlapenna' }],
      },
    }),
  );

  const result = await scan(api);

  assert.equal(result.needsAttention, 1);
  assert.equal(
    api.calls.some((call) => call.method !== 'GET' && call.method !== 'POST'),
    false,
  );
  assert.equal(
    api.calls.filter(
      (call) => call.method === 'POST' && call.basePath !== '/graphql',
    ).length,
    0,
    'an unchanged alert must perform no visible mutation',
  );
});

test('new check activity transitions the marker but never removes the shared needs-human label', async () => {
  const api = fakeApi([
    ...baseRoutes({
      checks: [check({ completed_at: '2026-08-01T23:00:00Z' })],
      comments: [
        {
          id: 50,
          user: { login: 'github-actions[bot]' },
          body: `${watchdogMarker(666)}\n${WATCHDOG_ATTENTION_STATE}`,
        },
      ],
    }),
    { path: `${ROOT}/issues/comments/50`, method: 'PATCH', data: {} },
  ]);

  const result = await scan(api);

  assert.equal(result.needsAttention, 0);
  assert.equal(result.recovered, 1);
  const patchCall = api.calls.find((call) => call.method === 'PATCH');
  assert.ok(patchCall.body.body.includes(WATCHDOG_RECOVERED_STATE));
  assert.match(patchCall.body.body, /intentionally left in place/u);
  assert.equal(
    api.calls.some((call) => call.method === 'DELETE'),
    false,
    'the shared status label has other owners and must never be removed',
  );
});

test('ignores human-authored PRs before any check, issue, or comment lookup', async () => {
  const api = fakeApi([
    {
      path: '/graphql',
      method: 'POST',
      data: graphqlResponse([prNode({ author: { login: 'jlapenna' } })]),
    },
  ]);

  const result = await scan(api);

  assert.deepEqual(result, {
    scanned: 1,
    agentPullRequests: 0,
    needsAttention: 0,
    recovered: 0,
    failed: [],
  });
  assert.deepEqual(
    api.calls.map((call) => call.basePath),
    ['/graphql'],
  );
});

test('a PR with no open closing reference surfaces on the PR itself', async () => {
  const node = prNode({
    closingIssuesReferences: { totalCount: 0, nodes: [] },
  });
  const api = fakeApi([
    { path: '/graphql', method: 'POST', data: graphqlResponse([node]) },
    {
      path: `${ROOT}/commits/sha-666/check-runs`,
      data: { check_runs: [check()] },
    },
    { path: `${ROOT}/issues/666/comments`, data: [] },
    { path: `${ROOT}/issues/666`, data: { labels: [], assignees: [] } },
    { path: `${ROOT}/issues/666/comments`, method: 'POST', data: {} },
    { path: `${ROOT}/issues/666/labels`, method: 'POST', data: {} },
    { path: `${ROOT}/issues/666/assignees`, method: 'POST', data: {} },
  ]);

  const result = await scan(api);

  assert.equal(result.failed.length, 0);
  assert.ok(
    api.calls.some(
      (call) =>
        call.basePath === `${ROOT}/issues/666/comments` &&
        call.method === 'POST',
    ),
  );
});

test('a forged human marker is never edited or trusted as the watchdog comment', async () => {
  const routes = baseRoutes({
    comments: [
      {
        id: 49,
        user: { login: 'jlapenna' },
        body: `${watchdogMarker(666)}\n${WATCHDOG_ATTENTION_STATE}`,
      },
    ],
  });
  routes.push(
    { path: `${ROOT}/issues/660/comments`, method: 'POST', data: {} },
    { path: `${ROOT}/issues/660/labels`, method: 'POST', data: {} },
    { path: `${ROOT}/issues/660/assignees`, method: 'POST', data: {} },
  );
  const api = fakeApi(routes);

  await scan(api);

  assert.equal(
    api.calls.some((call) => call.basePath === `${ROOT}/issues/comments/49`),
    false,
  );
  assert.ok(
    api.calls.some(
      (call) =>
        call.basePath === `${ROOT}/issues/660/comments` &&
        call.method === 'POST',
    ),
  );
});

test('a per-PR API failure is reported without blocking another PR', async () => {
  const second = prNode({
    number: 667,
    url: `https://github.com/${REPO}/pull/667`,
    headRefOid: 'sha-667',
    commits: {
      nodes: [{ commit: { committedDate: '2026-08-01T23:00:00Z' } }],
    },
    closingIssuesReferences: {
      totalCount: 1,
      nodes: [{ number: 661, state: 'OPEN' }],
    },
  });
  const api = fakeApi([
    {
      path: '/graphql',
      method: 'POST',
      data: graphqlResponse([prNode(), second]),
    },
    {
      path: `${ROOT}/commits/sha-666/check-runs`,
      error: new Error('checks API unavailable'),
    },
    {
      path: `${ROOT}/commits/sha-667/check-runs`,
      data: { check_runs: [] },
    },
    { path: `${ROOT}/issues/661/comments`, data: [] },
  ]);

  const result = await scan(api);

  assert.deepEqual(result.failed, [
    { pr: 666, message: 'checks API unavailable' },
  ]);
  assert.equal(result.agentPullRequests, 2);
  assert.ok(
    api.calls.some(
      (call) => call.basePath === `${ROOT}/commits/sha-667/check-runs`,
    ),
    'the second candidate must still be examined',
  );
});
