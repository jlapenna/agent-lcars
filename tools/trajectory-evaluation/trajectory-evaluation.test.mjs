import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  collectRecentCorpus,
  createReadOnlyGithubClient,
} from './github-source.mjs';
import { runOfflineComparison } from './offline-replay.mjs';
import { assertPrivacySafe, redactRecord } from './redact.mjs';
import {
  buildReport,
  compareVariant,
  renderComparisonMarkdown,
} from './report.mjs';
import { validateCorpus, validateVariant } from './schema.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const corpusPath = path.join(import.meta.dirname, 'corpus/v1/issue-523.json');
const variantPath = path.join(
  import.meta.dirname,
  'variants/issue-523-reliability-v1.json',
);

async function json(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'));
}

function response(value) {
  return { ok: true, status: 200, json: async () => structuredClone(value) };
}

function githubFixture({ privateRepository = false, includeRun = true } = {}) {
  const calls = [];
  const run = {
    id: 123456,
    name: 'dispatch:g2:#525',
    display_title: 'dispatch:g2:#525',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-08-08T10:00:00Z',
    updated_at: '2026-08-08T10:12:00Z',
    head_sha: '1234567890abcdef1234567890abcdef12345678',
    html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/123456',
    path: '.github/workflows/codex.yml',
    run_attempt: 1,
  };
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    const pathname = new URL(url).pathname;
    if (pathname === '/repos/jlapenna/agent-lcars')
      return response({ private: privateRepository });
    if (pathname.endsWith('/actions/workflows/codex.yml/runs')) {
      return response({ workflow_runs: includeRun ? [run] : [] });
    }
    if (pathname.includes('/actions/workflows/'))
      return response({ workflow_runs: [] });
    if (pathname === '/repos/jlapenna/agent-lcars/actions/runs/123456/jobs') {
      return response({
        jobs: [
          {
            name: 'codex',
            html_url: `${run.html_url}/job/9`,
            started_at: '2026-08-08T10:00:10Z',
            completed_at: '2026-08-08T10:12:00Z',
            steps: [
              {
                name: 'Run Codex',
                conclusion: 'success',
                started_at: '2026-08-08T10:01:00Z',
                completed_at: '2026-08-08T10:11:00Z',
              },
            ],
          },
        ],
      });
    }
    if (
      pathname === '/repos/jlapenna/agent-lcars/actions/runs/123456/artifacts'
    ) {
      return response({
        artifacts: [
          {
            id: 88,
            name: 'agent-dispatch-brief-123456-1',
            expired: false,
            archive_download_url:
              'https://api.github.com/repos/jlapenna/agent-lcars/actions/artifacts/88/zip',
          },
        ],
      });
    }
    if (pathname === '/repos/jlapenna/agent-lcars/issues/525') {
      return response({
        html_url: 'https://github.com/jlapenna/agent-lcars/issues/525',
        title: 'Secret-shaped text must not escape',
        body: '- [ ] keep github_pat_abcdefghijklmnopqrstuvwxyz1234567890 private',
        state: 'open',
        labels: [{ name: 'priority:p2' }],
      });
    }
    throw new Error(`unexpected fixture request ${String(url)}`);
  });
  return { calls, fetchImpl };
}

describe('frozen #523 corpus', () => {
  it('uses the versioned schema topology and exact reviewed 20-run cohort', async () => {
    const [schema, corpus] = await Promise.all([
      json(path.join(import.meta.dirname, 'schema/v1.schema.json')),
      json(corpusPath),
    ]);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$defs.entry.required).toEqual(
      expect.arrayContaining([
        'anchor',
        'dispatch',
        'setup',
        'protocol',
        'milestones',
        'trajectory',
        'terminal',
        'quality',
      ]),
    );
    expect(schema.$defs.sourceRef.required).toContain('access');
    expect(schema.properties.entries.minItems).toBeUndefined();

    expect(validateCorpus(corpus)).toBe(corpus);
    expect(corpus.entries).toHaveLength(20);
    expect(new Set(corpus.entries.map((entry) => entry.id))).toHaveProperty(
      'size',
      20,
    );
    expect(
      corpus.entries.every((entry) => entry.annotations.human !== null),
    ).toBe(true);
    expect(
      corpus.entries.every(
        (entry) => entry.anchor.snapshot.availability === 'reference-only',
      ),
    ).toBe(true);
  });

  it('reproduces the published audit and independent stage metrics', async () => {
    const report = buildReport(await json(corpusPath));
    expect(report.overall).toMatchObject({
      total: 20,
      workflowSuccesses: 10,
      preModelFailures: 8,
      runnable: 12,
      usefulRunnable: 11,
      protocolAdherent: 11,
      reviewedProtocol: 12,
      accepted: 10,
      mergedGreen: 8,
      falseNegatives: 1,
      repeatedOrTimedOut: 1,
      correctParkOrNoOp: 3,
      reviewedParkOrNoOp: 3,
    });
    expect(report.byAgent.codex.total).toBe(9);
    expect(
      report.byTaskClass['dispatch-observability'].repeatedOrTimedOut,
    ).toBe(1);
    expect(report.provenance.warning).toContain('not semantic correctness');
  });
});

describe('privacy-safe read-only collection', () => {
  it('only issues GET requests to api.github.com and emits automatic, unreviewed records', async () => {
    const fixture = githubFixture();
    const corpus = await collectRecentCorpus({
      repository: 'jlapenna/agent-lcars',
      days: 7,
      limit: 10,
      token: 'fixture-only-token',
      now: new Date('2026-08-08T12:00:00Z'),
      fetchImpl: fixture.fetchImpl,
    });

    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]).toMatchObject({
      id: 'run-123456',
      repositoryVisibility: 'public',
      protocol: { adherent: null },
      annotations: { human: null },
    });
    expect(corpus.entries[0].dispatch.brief.sourceRef).toMatchObject({
      kind: 'dispatch-brief',
      access: 'protected',
    });
    expect(fixture.calls.every((call) => call.init.method === 'GET')).toBe(
      true,
    );
    expect(
      fixture.calls.every((call) =>
        call.url.startsWith('https://api.github.com/'),
      ),
    ).toBe(true);
    expect(JSON.stringify(corpus)).not.toContain('fixture-only-token');
    assertPrivacySafe(corpus);
  });

  it('keeps private anchor content reference-only and permits an empty rolling window', async () => {
    const privateFixture = githubFixture({ privateRepository: true });
    const corpus = await collectRecentCorpus({
      repository: 'jlapenna/agent-lcars',
      days: 1,
      limit: 1,
      now: new Date('2026-08-08T12:00:00Z'),
      fetchImpl: privateFixture.fetchImpl,
    });
    expect(corpus.entries[0].anchor.snapshot).toMatchObject({
      availability: 'reference-only',
      title: null,
      bodySha256: null,
    });
    expect(JSON.stringify(corpus)).not.toContain('Secret-shaped text');

    const emptyFixture = githubFixture({ includeRun: false });
    const empty = await collectRecentCorpus({
      repository: 'jlapenna/agent-lcars',
      days: 1,
      limit: 1,
      now: new Date('2026-08-08T12:00:00Z'),
      fetchImpl: emptyFixture.fetchImpl,
    });
    expect(validateCorpus(empty).entries).toEqual([]);
  });

  it('redacts credential keys and credential-shaped values', () => {
    const redacted = redactRecord({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      note: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
      nested: { apiKey: 'not-for-a-corpus' },
    });
    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      note: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' },
    });
  });

  it('rejects alternate API hosts', () => {
    expect(() =>
      createReadOnlyGithubClient({
        apiBase: 'https://example.test',
        fetchImpl: vi.fn(),
      }),
    ).toThrow('restricted to https://api.github.com');
  });
});

describe('offline reviewed comparison', () => {
  it('compares the reviewed setup/prompt variant by agent and task class', async () => {
    const [corpus, variant] = await Promise.all([
      json(corpusPath),
      json(variantPath),
    ]);
    expect(validateVariant(variant)).toBe(variant);
    const comparison = compareVariant(corpus, variant);
    const markdown = renderComparisonMarkdown(comparison);

    expect(comparison.applied).toHaveLength(10);
    expect(comparison.baseline.overall.accepted).toBe(10);
    expect(comparison.candidate.overall.accepted).toBe(20);
    expect(comparison.candidate.overall.repeatedOrTimedOut).toBe(0);
    expect(comparison.candidate.byAgent.opencode.protocolAdherenceRate).toBe(1);
    expect(comparison.candidate.byTaskClass['console-routing'].accepted).toBe(
      4,
    );
    expect(markdown).toContain('## Regression checks');
    expect(markdown).toContain('## By task class');
    expect(markdown).toContain('human-reviewed counterfactuals');
  });

  it('has no production transport in the offline import path', async () => {
    const source = await readFile(
      path.join(import.meta.dirname, 'offline-replay.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(
      /github-source|octokit|child_process|node:https|node:http|\bfetch\b/u,
    );
    process.env.GH_TOKEN = 'must-not-be-consumed';
    try {
      const result = await runOfflineComparison({ corpusPath, variantPath });
      expect(result.comparison.applied).toHaveLength(10);
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  it('rejects expectations that are not in the selected frozen corpus', async () => {
    const [corpus, variant] = await Promise.all([
      json(corpusPath),
      json(variantPath),
    ]);
    variant.reviewedExpectations['run-999999'] = structuredClone(
      variant.reviewedExpectations['run-30759760688'],
    );
    expect(() => compareVariant(corpus, variant)).toThrow(
      'is not present in the corpus',
    );
  });
});

describe('scheduled evaluation boundary', () => {
  it('grants only GitHub read permissions and keeps artifacts local to the run', async () => {
    const workflowSource = await readFile(
      path.join(root, '.github/workflows/trajectory-evaluation.yml'),
      'utf8',
    );
    const workflow = parseYaml(workflowSource);
    expect(workflow.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'read',
      'pull-requests': 'read',
    });
    expect(workflowSource).not.toMatch(
      /id-token:\s*write|contents:\s*write|issues:\s*write|pull-requests:\s*write/u,
    );
    expect(workflowSource).not.toMatch(
      /firestore|terraform|workflow_dispatch[^\n]*POST|gh\s+(issue|pr)\s+(edit|close|create)/iu,
    );
    expect(workflowSource).toContain('$RUNNER_TEMP/trajectory-corpus.json');
  });
});
