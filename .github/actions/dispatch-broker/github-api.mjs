import {
  createLedger,
  LEDGER_MARKER,
  parseLedgerComment,
  renderLedgerComment,
} from './broker.mjs';

const API_VERSION = '2026-03-10';

class GitHubApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
  }
}

function createGitHubApi({
  token,
  fetchImpl = fetch,
  baseUrl = 'https://api.github.com',
}) {
  async function request(
    path,
    { method = 'GET', body, timeoutMs = 30_000 } = {},
  ) {
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
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GitHubApiError(
        `GitHub request transport failure: ${error.message}`,
        undefined,
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

function brokerConcurrencyGroup(task) {
  if (
    !Number.isSafeInteger(task?.repositoryId) ||
    task.repositoryId <= 0 ||
    !Number.isSafeInteger(task?.issue) ||
    task.issue <= 0
  ) {
    throw new Error('Cannot derive broker concurrency group from TaskRef');
  }
  return `agent-lcars-dispatch-v1-${task.repositoryId}-${task.issue}`;
}

function validateBrokerConcurrencyResponse(data, task, runId, suppliedGroup) {
  const expected = brokerConcurrencyGroup(task);
  if (suppliedGroup !== expected) {
    throw new Error('Broker concurrency output does not match its TaskRef');
  }
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Array.isArray(data?.concurrency_groups)
  ) {
    throw new Error('Malformed broker concurrency-group response');
  }
  const matching = data.concurrency_groups.filter(
    (group) =>
      typeof group?.group_name === 'string' &&
      group.group_name.toLowerCase() === expected.toLowerCase(),
  );
  if (matching.length !== 1) {
    throw new Error(
      'Broker run does not report the expected concurrency group',
    );
  }
  return matching[0];
}

async function verifyBrokerConcurrency(api, task, runId, suppliedGroup) {
  const data = await api.requestOk(
    `${repositoryPath(task)}/actions/runs/${runId}/concurrency_groups?per_page=100`,
  );
  return validateBrokerConcurrencyResponse(data, task, runId, suppliedGroup);
}

async function listAll(api, path) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await api.requestOk(
      `${path}${separator}per_page=100&page=${page}`,
    );
    if (!Array.isArray(data))
      throw new Error('GitHub pagination response is not an array');
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error('GitHub pagination exceeded safety bound');
}

async function loadLedger(
  api,
  task,
  workflowIdentity = 'github-actions[bot]',
  { createIfMissing = true } = {},
) {
  const root = repositoryPath(task);
  const comments = await listAll(api, `${root}/issues/${task.issue}/comments`);
  const candidates = comments.filter((comment) =>
    comment.body?.includes(LEDGER_MARKER),
  );
  if (candidates.length > 1) {
    throw new Error('Duplicate dispatch ledger comments');
  }
  if (candidates.length === 1) {
    const comment = candidates[0];
    if (
      comment.user?.login !== workflowIdentity ||
      comment.user?.type !== 'Bot'
    ) {
      throw new Error('Dispatch ledger author is not the workflow identity');
    }
    return {
      comment,
      ledger: parseLedgerComment(comment.body, task),
      created: false,
    };
  }

  if (!createIfMissing) return undefined;

  const ledger = createLedger(task);
  const comment = await api.requestOk(`${root}/issues/${task.issue}/comments`, {
    method: 'POST',
    body: { body: renderLedgerComment(ledger) },
  });
  if (!Number.isSafeInteger(comment?.id)) {
    throw new Error('GitHub did not return the created ledger comment ID');
  }
  return { comment, ledger, created: true, existingComments: comments };
}

async function saveLedger(api, loaded) {
  const root = repositoryPath(loaded.ledger.task);
  const comment = await api.requestOk(
    `${root}/issues/comments/${loaded.comment.id}`,
    {
      method: 'PATCH',
      body: { body: renderLedgerComment(loaded.ledger) },
    },
  );
  loaded.comment = comment;
  return loaded;
}

async function pinLedgerWhenUnoccupied(api, loaded, isPullRequest) {
  if (!loaded.created || isPullRequest)
    return { pinned: false, reason: 'ineligible' };
  if (loaded.existingComments.some((comment) => comment.pin)) {
    return { pinned: false, reason: 'occupied' };
  }
  const root = repositoryPath(loaded.ledger.task);
  try {
    await api.requestOk(`${root}/issues/comments/${loaded.comment.id}/pin`, {
      method: 'PUT',
    });
    return { pinned: true };
  } catch (error) {
    return {
      pinned: false,
      reason: `best-effort-failed:${error.status ?? 'transport'}`,
    };
  }
}

function workerWorkflow(pipeline) {
  const workflow = {
    claude: 'claude.yml',
    codex: 'codex.yml',
    opencode: 'opencode.yml',
  }[pipeline];
  if (!workflow) throw new Error(`Unsupported worker pipeline: ${pipeline}`);
  return workflow;
}

function validateDispatchResponse(response, task) {
  if (response.status !== 200) {
    throw new GitHubApiError(
      `Workflow dispatch returned HTTP ${response.status}`,
      response.status,
      response.data,
    );
  }
  const runId = response.data?.workflow_run_id;
  const runUrl = response.data?.run_url;
  const htmlUrl = response.data?.html_url;
  const { owner, repo } = splitRepository(task.repository);
  const expectedRunUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    typeof runUrl !== 'string' ||
    runUrl !== expectedRunUrl ||
    typeof htmlUrl !== 'string' ||
    htmlUrl !== expectedHtmlUrl
  ) {
    throw new GitHubApiError(
      'Workflow dispatch returned malformed run details',
      200,
      response.data,
    );
  }
  return { runId, runUrl, htmlUrl };
}

async function dispatchWorker(api, generation, task) {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const response = await api.request(
    `${root}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          issue: String(task.issue),
          mode: generation.mode,
          reply: generation.reply ?? '',
          runbook: generation.runbook ?? '',
          context: generation.context ?? '',
          broker_intent_id: generation.intentId,
          broker_generation: String(generation.generation),
          broker_dispatch_token: generation.attempt.token,
        },
      },
    },
  );
  return { ...validateDispatchResponse(response, task), workflow };
}

async function getWorkflowRun(api, task, runId) {
  return api.requestOk(`${repositoryPath(task)}/actions/runs/${runId}`);
}

async function findRunsForGeneration(api, task, generation) {
  const workflow = workerWorkflow(generation.pipeline);
  const data = await api.requestOk(
    `${repositoryPath(task)}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100`,
  );
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  return (data.workflow_runs ?? []).filter((run) =>
    run.display_title?.includes(marker),
  );
}

async function failClosed(api, task, maintainer, message) {
  const root = repositoryPath(task);
  await api.requestOk(`${root}/issues/${task.issue}/labels`, {
    method: 'POST',
    body: { labels: ['status:needs-human'] },
  });
  if (maintainer) {
    await api.requestOk(`${root}/issues/${task.issue}/assignees`, {
      method: 'POST',
      body: { assignees: [maintainer] },
    });
  }
  throw new Error(message);
}

export {
  API_VERSION,
  brokerConcurrencyGroup,
  createGitHubApi,
  dispatchWorker,
  failClosed,
  findRunsForGeneration,
  getWorkflowRun,
  GitHubApiError,
  listAll,
  loadLedger,
  pinLedgerWhenUnoccupied,
  repositoryPath,
  saveLedger,
  splitRepository,
  validateBrokerConcurrencyResponse,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
};
