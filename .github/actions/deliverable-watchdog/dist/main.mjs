// apps/dispatch-broker/src/deliverable-watchdog/main.ts
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// apps/dispatch-broker/src/github-api.ts
var API_VERSION = '2026-03-10';
var GitHubApiError = class extends Error {
  status;
  data;
  constructor(message, status, data) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
  }
};
function createGitHubApi({
  token,
  fetchImpl = fetch,
  baseUrl = 'https://api.github.com',
}) {
  async function request(path, { method = 'GET', body, timeoutMs = 3e4 } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        ...(body !== void 0 && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GitHubApiError(
        // Genuinely untrusted here -- whatever fetchImpl rejected with, of
        // any shape. Every real fetch failure is Error-shaped; same
        // assumption the untyped original made without checking.
        `GitHub request transport failure: ${error.message}`,
        void 0,
      );
    }
    const text = await response.text();
    let data;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { malformedBody: text.slice(0, 500) };
      }
    }
    return { status: response.status, data, headers: response.headers };
  }
  async function requestOk(path, options) {
    const response = await request(path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError(
        `GitHub request failed with HTTP ${response.status}`,
        response.status,
        response.data,
      );
    }
    return response.data;
  }
  return { request, requestOk };
}
function splitRepository(repository) {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error('Invalid repository identity');
  return { owner, repo };
}
function repositoryPath(task) {
  const { owner, repo } = splitRepository(task.repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}
var FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS = 5 * 60 * 1e3;

// apps/dispatch-broker/src/deliverable-watchdog/detect.ts
var DELIVERABLE_WATCHDOG_MARKER_PREFIX =
  '<!-- agent-lcars:deliverable-watchdog:v1:pr=';
var WATCHDOG_ATTENTION_STATE = '**Watchdog state:** needs-attention';
var WATCHDOG_RECOVERED_STATE = '**Watchdog state:** activity-resumed';
function timestamp(value, field) {
  if (!value) throw new Error(`${field} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${field} is invalid: ${value}`);
  return parsed;
}
function optionalTimestamp(value) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
function normalizeGraphqlBotLogin(login) {
  return login.startsWith('app/') ? `${login.slice(4)}[bot]` : login;
}
function parseAgentBotLogins(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('AGENT_BOT_LOGINS must be valid JSON', { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((login) => typeof login !== 'string' || login.length === 0)
  ) {
    throw new Error(
      'AGENT_BOT_LOGINS must be a non-empty JSON array of logins',
    );
  }
  return new Set(parsed);
}
function checkActivity(check) {
  return Math.max(
    optionalTimestamp(check.completedAt),
    optionalTimestamp(check.startedAt),
  );
}
function selectLatestRequiredCheck(checks, requiredCheck) {
  return checks
    .filter((check) => check.name === requiredCheck)
    .sort((left, right) => {
      const activityDelta = checkActivity(right) - checkActivity(left);
      return activityDelta || right.id - left.id;
    })[0];
}
function evaluateDeliverable(
  pullRequest,
  checks,
  requiredCheck,
  staleAfterMs,
  now,
) {
  const check = selectLatestRequiredCheck(checks, requiredCheck);
  const activityMs = Math.max(
    timestamp(pullRequest.createdAt, `PR #${pullRequest.number} createdAt`),
    timestamp(
      pullRequest.headCommittedAt,
      `PR #${pullRequest.number} head committedAt`,
    ),
    check ? checkActivity(check) : Number.NEGATIVE_INFINITY,
  );
  const ageMs = Math.max(0, now.getTime() - activityMs);
  const activityAt = new Date(activityMs).toISOString();
  if (ageMs < staleAfterMs) {
    return {
      needsAttention: false,
      activityAt,
      ageMs,
      check,
      reason:
        'head or required-check activity is still inside the watchdog window',
    };
  }
  let reason;
  if (!check) {
    reason = `required check ${requiredCheck} is missing`;
  } else if (check.status !== 'completed') {
    reason = `required check ${requiredCheck} is still ${check.status}`;
  } else if (check.conclusion === 'success') {
    reason = `required check ${requiredCheck} passed, but the PR remains open`;
  } else {
    reason = `required check ${requiredCheck} concluded ${check.conclusion ?? 'without a conclusion'}`;
  }
  if (pullRequest.isDraft) reason += '; the PR is still a draft';
  return {
    needsAttention: true,
    activityAt,
    ageMs,
    check,
    reason,
  };
}
function watchdogMarker(prNumber) {
  return `${DELIVERABLE_WATCHDOG_MARKER_PREFIX}${prNumber} -->`;
}
function ageHours(ageMs) {
  return (ageMs / (60 * 60 * 1e3)).toFixed(1);
}
function renderAttentionComment(pullRequest, evaluation, requiredCheck) {
  const checkUrl = evaluation.check?.url
    ? `
- Required check: [${requiredCheck}](${evaluation.check.url})`
    : '';
  return `${watchdogMarker(pullRequest.number)}

### Agent deliverable needs attention

${WATCHDOG_ATTENTION_STATE}

[PR #${pullRequest.number}](${pullRequest.url}) has remained open with no head-commit or required-check activity for ${ageHours(evaluation.ageMs)} hours.

- Last activity: ${evaluation.activityAt}
- Reason: ${evaluation.reason}${checkUrl}

This watchdog never rebases or merges a PR. A maintainer must inspect the deliverable and decide whether to rerun checks, update, merge, close, or supersede it.`;
}
function renderRecoveredComment(pullRequest, evaluation) {
  return `${watchdogMarker(pullRequest.number)}

### Agent deliverable activity resumed

${WATCHDOG_RECOVERED_STATE}

[PR #${pullRequest.number}](${pullRequest.url}) has new head-commit or required-check activity as of ${evaluation.activityAt}, so it is no longer beyond the watchdog window.

The shared status:needs-human label is intentionally left in place: this watchdog cannot prove that no other dispatch or reporting failure owns that label. A maintainer can clear it after reviewing the task.`;
}

// apps/dispatch-broker/src/deliverable-watchdog/main.ts
var DEFAULT_REQUIRED_CHECK = 'Verify';
var DEFAULT_STALE_HOURS = 6;
var MAX_PAGES = 10;
var SCAN_CONCURRENCY = 3;
var GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';
var OPEN_PULL_REQUESTS_QUERY = `
  query DeliverableWatchdog($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 50, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          url
          createdAt
          isDraft
          headRefOid
          author { login }
          commits(last: 1) { nodes { commit { committedDate } } }
          closingIssuesReferences(first: 20) {
            totalCount
            nodes { number state }
          }
        }
      }
    }
  }
`;
function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}
async function output(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await fs.appendFile(
    outputPath,
    `${name}=${value}
`,
    'utf8',
  );
}
function parseStaleHours(raw) {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error('STALE_HOURS must be greater than 0 and at most 168');
  }
  return hours;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function listOpenPullRequests(api, repository) {
  const { owner, repo: name } = splitRepository(repository);
  const pullRequests = [];
  let after = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api.requestOk('/graphql', {
      method: 'POST',
      body: {
        query: OPEN_PULL_REQUESTS_QUERY,
        variables: { owner, name, after },
      },
    });
    if (response.errors?.length) {
      throw new Error(
        `GitHub GraphQL pull-request listing failed: ${response.errors.map((error) => error.message ?? 'unknown error').join('; ')}`,
      );
    }
    const connection = response.data?.repository?.pullRequests;
    if (!connection)
      throw new Error('GitHub GraphQL response omitted pullRequests');
    for (const node of connection.nodes ?? []) {
      const closing = node.closingIssuesReferences;
      if ((closing?.totalCount ?? 0) > (closing?.nodes?.length ?? 0)) {
        throw new Error(
          `PR #${node.number} has more than 20 closing issue references; refusing to silently omit anchors`,
        );
      }
      const headCommittedAt = node.commits?.nodes?.[0]?.commit?.committedDate;
      if (!headCommittedAt) {
        throw new Error(`PR #${node.number} omitted its head commit timestamp`);
      }
      const anchors = (closing?.nodes ?? [])
        .filter((issue) => issue.state === 'OPEN')
        .map((issue) => issue.number);
      pullRequests.push({
        number: node.number,
        url: node.url,
        authorLogin: normalizeGraphqlBotLogin(node.author?.login ?? ''),
        createdAt: node.createdAt,
        headCommittedAt,
        headSha: node.headRefOid,
        isDraft: node.isDraft,
        anchors: anchors.length > 0 ? anchors : [node.number],
      });
    }
    if (!connection.pageInfo?.hasNextPage) return pullRequests;
    after = connection.pageInfo.endCursor ?? null;
    if (!after) throw new Error('GitHub GraphQL pagination omitted endCursor');
  }
  throw new Error('GitHub pull-request pagination exceeded safety bound');
}
async function listCheckRuns(api, root, headSha) {
  const checks = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api.requestOk(
      `${root}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
    );
    const pageChecks = response.check_runs ?? [];
    checks.push(
      ...pageChecks.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        startedAt: check.started_at,
        completedAt: check.completed_at,
        url: check.html_url,
      })),
    );
    if (pageChecks.length < 100) return checks;
  }
  throw new Error('GitHub check-run pagination exceeded safety bound');
}
async function listComments(api, root, issue) {
  const comments = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageComments = await api.requestOk(
      `${root}/issues/${issue}/comments?per_page=100&page=${page}`,
    );
    comments.push(...pageComments);
    if (pageComments.length < 100) return comments;
  }
  throw new Error(`Comment pagination for #${issue} exceeded safety bound`);
}
function findWatchdogComment(comments, prNumber) {
  const marker = watchdogMarker(prNumber);
  const matches = comments
    .filter(
      (comment) =>
        comment.user?.login === GITHUB_ACTIONS_LOGIN &&
        (comment.body ?? '').includes(marker),
    )
    .sort((left, right) => left.id - right.id);
  if (matches.length > 1) {
    console.log(
      `::warning::Found ${matches.length} watchdog comments for PR #${prNumber}; updating the oldest (#${matches[0].id}).`,
    );
  }
  return matches[0];
}
function hasLabel(issue, label) {
  return (issue.labels ?? []).some((candidate) =>
    typeof candidate === 'string'
      ? candidate === label
      : candidate.name === label,
  );
}
function hasAssignee(issue, login) {
  return (issue.assignees ?? []).some((assignee) => assignee.login === login);
}
async function ensureAttention(
  api,
  root,
  anchor,
  pullRequest,
  commentBody,
  maintainer,
) {
  const [comments, issue] = await Promise.all([
    listComments(api, root, anchor),
    api.requestOk(`${root}/issues/${anchor}`),
  ]);
  const comment = findWatchdogComment(comments, pullRequest.number);
  if (!comment) {
    await api.requestOk(`${root}/issues/${anchor}/comments`, {
      method: 'POST',
      body: { body: commentBody },
    });
  } else if (!(comment.body ?? '').includes(WATCHDOG_ATTENTION_STATE)) {
    await api.requestOk(`${root}/issues/comments/${comment.id}`, {
      method: 'PATCH',
      body: { body: commentBody },
    });
  }
  if (!hasLabel(issue, 'status:needs-human')) {
    await api.requestOk(`${root}/issues/${anchor}/labels`, {
      method: 'POST',
      body: { labels: ['status:needs-human'] },
    });
  }
  if (!hasAssignee(issue, maintainer)) {
    await api.requestOk(`${root}/issues/${anchor}/assignees`, {
      method: 'POST',
      body: { assignees: [maintainer] },
    });
  }
}
async function recoverAttention(api, root, anchor, pullRequest, commentBody) {
  const comment = findWatchdogComment(
    await listComments(api, root, anchor),
    pullRequest.number,
  );
  if (!comment || !(comment.body ?? '').includes(WATCHDOG_ATTENTION_STATE)) {
    return false;
  }
  await api.requestOk(`${root}/issues/comments/${comment.id}`, {
    method: 'PATCH',
    body: { body: commentBody },
  });
  return true;
}
async function scanDeliverables({
  api,
  repository,
  agentBotLogins,
  maintainer,
  requiredCheck = DEFAULT_REQUIRED_CHECK,
  staleHours = DEFAULT_STALE_HOURS,
  now = /* @__PURE__ */ new Date(),
}) {
  if (!maintainer) throw new Error('maintainer is required');
  if (!requiredCheck) throw new Error('requiredCheck is required');
  if (!Number.isFinite(staleHours) || staleHours <= 0 || staleHours > 168) {
    throw new Error('staleHours must be greater than 0 and at most 168');
  }
  const root = repositoryPath({ repository });
  const allPullRequests = await listOpenPullRequests(api, repository);
  const agentPullRequests = allPullRequests.filter((pullRequest) =>
    agentBotLogins.has(pullRequest.authorLogin),
  );
  const result = {
    scanned: allPullRequests.length,
    agentPullRequests: agentPullRequests.length,
    needsAttention: 0,
    recovered: 0,
    failed: [],
  };
  const outcomes = await mapWithConcurrency(
    agentPullRequests,
    SCAN_CONCURRENCY,
    async (pullRequest) => {
      const checks = await listCheckRuns(api, root, pullRequest.headSha);
      const evaluation = evaluateDeliverable(
        pullRequest,
        checks,
        requiredCheck,
        staleHours * 60 * 60 * 1e3,
        now,
      );
      if (evaluation.needsAttention) result.needsAttention += 1;
      for (const anchor of pullRequest.anchors) {
        try {
          if (evaluation.needsAttention) {
            await ensureAttention(
              api,
              root,
              anchor,
              pullRequest,
              renderAttentionComment(pullRequest, evaluation, requiredCheck),
              maintainer,
            );
          } else if (
            await recoverAttention(
              api,
              root,
              anchor,
              pullRequest,
              renderRecoveredComment(pullRequest, evaluation),
            )
          ) {
            result.recovered += 1;
          }
        } catch (error) {
          result.failed.push({
            pr: pullRequest.number,
            anchor,
            message: errorMessage(error),
          });
        }
      }
    },
  );
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      result.failed.push({
        pr: agentPullRequests[index].number,
        message: errorMessage(outcome.reason),
      });
    }
  });
  return result;
}
async function run() {
  const staleHours = parseStaleHours(
    env('STALE_HOURS', false) || String(DEFAULT_STALE_HOURS),
  );
  const result = await scanDeliverables({
    api: createGitHubApi({ token: env('GITHUB_TOKEN') }),
    repository: env('GITHUB_REPOSITORY'),
    agentBotLogins: parseAgentBotLogins(env('AGENT_BOT_LOGINS')),
    maintainer: env('MAINTAINER_LOGIN'),
    requiredCheck: env('REQUIRED_CHECK', false) || DEFAULT_REQUIRED_CHECK,
    staleHours,
  });
  console.log(
    `deliverable-watchdog: scanned ${result.scanned} open PR(s), ${result.agentPullRequests} agent-authored, ${result.needsAttention} need attention, ${result.recovered} resumed, ${result.failed.length} failed operation(s).`,
  );
  await output('scanned', String(result.scanned));
  await output('needs-attention', String(result.needsAttention));
  await output('recovered', String(result.recovered));
  if (result.failed.length > 0) {
    throw new Error(
      `Deliverable watchdog failed: ${result.failed.map((failure) => `PR #${failure.pr}${failure.anchor ? ` anchor #${failure.anchor}` : ''}: ${failure.message}`).join(' | ')}`,
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await run();
}
export { scanDeliverables };
