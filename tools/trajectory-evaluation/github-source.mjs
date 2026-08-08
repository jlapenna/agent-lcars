import { createHash } from 'node:crypto';

import { assertPrivacySafe, redactRecord } from './redact.mjs';
import { validateCorpus } from './schema.mjs';

const WORKFLOWS = [
  {
    agent: 'claude',
    path: '.github/workflows/claude.yml',
    file: 'claude.yml',
    provider: 'anthropic',
  },
  {
    agent: 'codex',
    path: '.github/workflows/codex.yml',
    file: 'codex.yml',
    provider: 'openai',
  },
  {
    agent: 'opencode',
    path: '.github/workflows/opencode.yml',
    file: 'opencode.yml',
    provider: 'homelab-litellm',
  },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceRef(kind, url, access = 'public') {
  return { kind, url, sha256: null, access };
}

function secondsBetween(start, end) {
  if (!start || !end) return null;
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
}

function workflowConclusion(value) {
  return ['success', 'failure', 'cancelled', 'timed_out'].includes(value)
    ? value
    : 'unknown';
}

function parseRunIdentity(run) {
  const anchor = /#([0-9]+)/u.exec(run.display_title ?? run.name ?? '');
  const generation = /dispatch:g([0-9]+):/u.exec(
    run.display_title ?? run.name ?? '',
  );
  return {
    anchor: anchor ? Number(anchor[1]) : null,
    generation: generation ? Number(generation[1]) : null,
  };
}

function agentStep(steps) {
  return steps.find((step) =>
    /^Run (?:Claude Code|Codex|OpenCode)$/u.test(step.name),
  );
}

function inferSetup(steps) {
  const agent = agentStep(steps);
  const agentProcessStarted = agent ? agent.conclusion !== 'skipped' : false;
  if (agentProcessStarted) {
    return {
      outcome: 'ready',
      agentProcessStarted: true,
      modelTurnObserved: agent.conclusion === 'success' ? true : null,
    };
  }
  const failure = steps.find((step) => step.conclusion === 'failure');
  const name = failure?.name ?? '';
  if (/auth|credential|login|token|secret/iu.test(name)) {
    return {
      outcome: 'credential-failure',
      agentProcessStarted: false,
      modelTurnObserved: false,
    };
  }
  if (/provider|canary/iu.test(name)) {
    return {
      outcome: 'provider-failure',
      agentProcessStarted: false,
      modelTurnObserved: false,
    };
  }
  return {
    outcome: 'bootstrap-failure',
    agentProcessStarted: false,
    modelTurnObserved: false,
  };
}

function inferTerminal(run, setup) {
  if (run.conclusion === 'success') return 'unknown-success';
  if (setup.agentProcessStarted === false) return 'startup-failure';
  return 'trajectory-failure';
}

function acceptanceCriteria(body) {
  return (body ?? '')
    .split(/\r?\n/gu)
    .map((line) => /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/u.exec(line)?.[1])
    .filter(Boolean);
}

export function createReadOnlyGithubClient({
  token,
  fetchImpl = fetch,
  apiBase = 'https://api.github.com',
}) {
  const base = new URL(apiBase);
  if (base.protocol !== 'https:' || base.hostname !== 'api.github.com') {
    throw new Error(
      'production collection is restricted to https://api.github.com',
    );
  }
  return {
    async get(path) {
      if (!path.startsWith('/'))
        throw new Error('GitHub API path must start with /');
      const response = await fetchImpl(new URL(path, base), {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'agent-lcars-trajectory-evaluation',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok)
        throw new Error(`GitHub read failed (${response.status}) for ${path}`);
      return response.json();
    },
  };
}

async function listRuns(client, repository, workflow, since) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      per_page: '100',
      page: String(page),
      created: `>=${since}`,
    });
    const payload = await client.get(
      `/repos/${repository}/actions/workflows/${workflow.file}/runs?${query.toString()}`,
    );
    const pageRuns = payload.workflow_runs ?? [];
    runs.push(
      ...pageRuns.map((run) => ({
        ...run,
        agent: workflow.agent,
        provider: workflow.provider,
        path: workflow.path,
      })),
    );
    if (pageRuns.length < 100) break;
  }
  return runs;
}

async function mapLimited(values, limit, callback) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await callback(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return output;
}

export async function collectRecentCorpus({
  repository,
  days,
  token,
  now = new Date(),
  limit = 100,
  fetchImpl = fetch,
}) {
  if (!/^[^/]+\/[^/]+$/u.test(repository))
    throw new Error('repository must be owner/repo');
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error('days must be an integer from 1 to 90');
  if (!Number.isInteger(limit) || limit < 1 || limit > 300)
    throw new Error('limit must be 1..300');
  const client = createReadOnlyGithubClient({ token, fetchImpl });
  const repositoryMetadata = await client.get(`/repos/${repository}`);
  const visibility = repositoryMetadata.private ? 'private' : 'public';
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const workflowRuns = (
    await Promise.all(
      WORKFLOWS.map((workflow) =>
        listRuns(client, repository, workflow, since),
      ),
    )
  )
    .flat()
    .filter((run) => run.status === 'completed' && run.conclusion !== 'skipped')
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, limit);

  const issueCache = new Map();
  const entries = await mapLimited(workflowRuns, 6, async (run) => {
    const identity = parseRunIdentity(run);
    if (!identity.anchor) return null;
    const jobsPayload = await client.get(
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    const artifactsPayload = await client.get(
      `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    const jobs = jobsPayload.jobs ?? [];
    const artifacts = artifactsPayload.artifacts ?? [];
    const job =
      jobs.find((candidate) => candidate.name === run.agent) ?? jobs[0];
    const steps = job?.steps ?? [];
    const step = agentStep(steps);
    const setup = inferSetup(steps);
    let issue = issueCache.get(identity.anchor);
    if (!issue) {
      issue = await client.get(
        `/repos/${repository}/issues/${identity.anchor}`,
      );
      issueCache.set(identity.anchor, issue);
    }
    const issueUrl =
      issue.html_url ??
      `https://github.com/${repository}/issues/${identity.anchor}`;
    const runRef = sourceRef('workflow-run', run.html_url);
    const jobRef = sourceRef('workflow-job', job?.html_url ?? run.html_url);
    const issueRef = sourceRef(
      'issue',
      issueUrl,
      visibility === 'public' ? 'public' : 'protected',
    );
    const dispatchArtifact = artifacts.find(
      (artifact) =>
        artifact.expired !== true &&
        artifact.name?.startsWith('agent-dispatch-brief-'),
    );
    const dispatchArtifactRef = dispatchArtifact
      ? sourceRef(
          'dispatch-brief',
          dispatchArtifact.archive_download_url ??
            `https://api.github.com/repos/${repository}/actions/artifacts/${dispatchArtifact.id}/zip`,
          'protected',
        )
      : null;
    const trajectoryRefs = artifacts
      .filter(
        (artifact) =>
          artifact.expired !== true &&
          artifact.name?.startsWith('opencode-trajectory-'),
      )
      .map((artifact) =>
        sourceRef(
          'trajectory-archive',
          artifact.archive_download_url ??
            `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
          'protected',
        ),
      );
    const snapshot =
      visibility === 'public'
        ? {
            availability: 'captured',
            capturedAt: now.toISOString(),
            sourceRef: issueRef,
            title: issue.title ?? null,
            state: issue.state ?? 'unknown',
            labels: (issue.labels ?? []).map((label) =>
              typeof label === 'string' ? label : label.name,
            ),
            bodySha256: issue.body ? sha256(issue.body) : null,
            acceptanceCriteria: acceptanceCriteria(issue.body),
          }
        : {
            availability: 'reference-only',
            capturedAt: null,
            sourceRef: issueRef,
            title: null,
            state: 'unknown',
            labels: [],
            bodySha256: null,
            acceptanceCriteria: [],
          };
    const runnerSeconds = secondsBetween(job?.started_at, job?.completed_at);
    const modelSeconds =
      setup.modelTurnObserved === true
        ? secondsBetween(step?.started_at, step?.completed_at)
        : null;
    return {
      id: `run-${run.id}`,
      repository,
      repositoryVisibility: visibility,
      anchor: {
        number: identity.anchor,
        type: issue.pull_request ? 'pull-request' : 'issue',
        snapshot,
      },
      taskClass: 'unreviewed',
      dispatch: {
        mode: 'unknown',
        generation: identity.generation,
        workflowSha: run.head_sha,
        workflowPath: run.path,
        runId: run.id,
        runUrl: run.html_url,
        workflowConclusion: workflowConclusion(run.conclusion),
        agent: run.agent,
        provider: run.provider,
        model: run.agent === 'opencode' ? 'homelab/default' : null,
        budgetMinutes: null,
        brief: {
          availability: 'reference-only',
          capturedAt: null,
          sourceRef:
            dispatchArtifactRef ?? sourceRef('dispatch-brief', run.html_url),
          title: null,
          state: 'unknown',
          labels: [],
          bodySha256: null,
          acceptanceCriteria: [],
        },
      },
      setup,
      protocol: {
        takeover: 'unknown',
        progress: 'unknown',
        durableResult: 'unknown',
        terminalBehavior: 'unknown',
        adherent: null,
      },
      milestones: {
        queuedAt: run.created_at,
        agentStartedAt: setup.agentProcessStarted
          ? (step?.started_at ?? null)
          : null,
        takeoverAt: null,
        diagnosisAt: null,
        firstDurableArtifactAt: null,
        terminalAt: run.updated_at,
      },
      trajectory: {
        outcome:
          setup.modelTurnObserved === false
            ? 'not-started'
            : run.conclusion === 'success'
              ? 'productive'
              : 'unknown',
        archiveRefs: trajectoryRefs,
      },
      terminal: { kind: inferTerminal(run, setup), artifactRefs: [] },
      quality: {
        accepted: null,
        ci: 'unknown',
        review: 'unknown',
        merged: null,
        regression: 'unknown',
      },
      efficiency: {
        queueSeconds: secondsBetween(run.created_at, job?.started_at),
        modelSeconds,
        firstArtifactSeconds: null,
        runnerMinutes: runnerSeconds === null ? null : runnerSeconds / 60,
        retries: Math.max(0, (run.run_attempt ?? 1) - 1),
      },
      annotations: {
        automatic: { confidence: 'medium', sourceRefs: [runRef, jobRef] },
        human: null,
      },
      sourceRefs: [
        runRef,
        jobRef,
        issueRef,
        ...(dispatchArtifactRef ? [dispatchArtifactRef] : []),
        ...trajectoryRefs,
      ],
    };
  });

  const corpus = redactRecord({
    schemaVersion: 'agent-lcars.trajectory-corpus/v1',
    corpusId: `${repository.replace('/', '-')}-rolling-${days}d-${now.toISOString().slice(0, 10)}`,
    frozenAt: now.toISOString(),
    sourceWindow: {
      from: since,
      to: now.toISOString(),
      selection: `Latest ${limit} completed, non-skipped Claude/Codex/OpenCode runs in the ${days}-day window`,
      sourceRefs: WORKFLOWS.map((workflow) =>
        sourceRef(
          'workflow-run',
          `https://github.com/${repository}/actions/workflows/${workflow.file}`,
          visibility === 'public' ? 'public' : 'protected',
        ),
      ),
    },
    privacy: {
      contentPolicy:
        visibility === 'public' ? 'public-metadata' : 'reference-only',
      redactionPolicy: 'agent-lcars.trajectory-redaction/v1',
      transcriptPolicy: 'protected-reference-only',
    },
    entries: entries.filter(Boolean),
  });
  validateCorpus(corpus);
  assertPrivacySafe(corpus);
  return corpus;
}
