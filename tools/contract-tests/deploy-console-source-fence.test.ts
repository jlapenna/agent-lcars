import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
}
interface Concurrency {
  group?: string;
  queue?: unknown;
  'cancel-in-progress'?: unknown;
}
const workflow = parse(
  readFileSync('.github/workflows/deploy-console.yml', 'utf8'),
) as {
  concurrency?: Concurrency;
  jobs: Record<string, { steps: Step[]; concurrency?: Concurrency }>;
};
const BASE = '0'.repeat(40);
const OLD = 'a'.repeat(40),
  NEW = 'b'.repeat(40);
const guard = workflow.jobs.deploy.steps.find((step) => step.id === 'source');

interface Rollout {
  source?: string;
  updated?: string;
  end?: string;
  conclusion?: string;
  verify?: string;
  marker?: string;
  attempts?: Rollout[];
  missingStart?: boolean;
  missingSteps?: boolean;
}
function sourceDecision(
  source: string,
  main: string,
  event = 'workflow_run',
  fail = false,
  deliveryMode = '',
  rollouts: Rollout[] = [{ source: NEW }],
  incomplete = false,
  concurrent: { newer: number } | undefined = undefined,
  history = 0,
) {
  if (guard === undefined) return { status: 0, output: 'true', calls: '' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-source-fence-'));
  const output = path.join(dir, 'output'),
    calls = path.join(dir, 'calls');
  const time = '2026-10-13T01:00:00Z';
  const routes: Record<string, unknown> = {
    'git/ref/heads/main': { object: { sha: main } },
  };
  const rows = rollouts.map((run, i) => {
    const jobs = (run.attempts ?? [run]).map((attempt, j) => ({
      id: i * 10 + j + 1,
      name: 'deploy',
      started_at: '2026-10-13T00:00:00Z',
      ...(run.missingSteps
        ? {}
        : {
            steps: [
              {
                name: 'Deploy with managed App Hosting build',
                status: 'completed',
                conclusion: attempt.conclusion ?? 'success',
                started_at: attempt.missingStart
                  ? undefined
                  : new Date(
                      new Date(attempt.end ?? time).getTime() - 60000,
                    ).toISOString(),
                completed_at: attempt.end ?? time,
              },
              {
                name: 'Verify the deployed console is serving',
                status: 'completed',
                conclusion: attempt.verify ?? 'success',
              },
            ],
          }),
    }));
    routes[`actions/runs/${i + 1}/jobs?filter=all&per_page=100`] = {
      total_count: jobs.length,
      jobs,
    };
    return {
      id: i + 1,
      created_at: '2026-10-13T00:30:00Z',
      updated_at: run.updated ?? time,
      // Displayed workflow SHA intentionally differs from effect source.
      head_sha: main,
      display_title:
        run.marker ?? `Deploy console [source:${run.source ?? NEW}]`,
      conclusion: 'success',
    };
  });
  // Older history: runs updated before every rollout above, so the reader
  // counts them but never needs their jobs.
  for (let i = 0; i < history; i++) {
    rows.push({
      id: 100000 + i,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      head_sha: main,
      display_title: 'Deploy console (skipped PR)',
      conclusion: 'skipped',
    });
  }
  const total = rows.length + Number(incomplete);
  // Rows created after the reader's ceiling, newest first: skipped PR runs
  // created during discovery, the condition observed in production.
  const newer = Array.from({ length: concurrent?.newer ?? 0 }, (_, i) => ({
    id: 1000 + i,
    created_at: '2999-01-01T00:00:00Z',
    updated_at: '2999-01-01T00:00:00Z',
    display_title: 'Deploy console (skipped PR)',
    conclusion: 'skipped',
  }));
  writeFileSync(
    path.join(dir, 'runs'),
    JSON.stringify({
      rows,
      newer,
      total,
    }),
  );
  writeFileSync(output, '');
  writeFileSync(path.join(dir, 'routes'), JSON.stringify(routes));
  writeFileSync(
    path.join(dir, 'gh'),
    `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
with open(os.environ['FIXTURE_CALLS'], 'a') as f: f.write(' '.join(args)+'\\n')
if os.environ['FIXTURE_FAIL']=='true': sys.exit(1)
route=args[1].removeprefix('repos/jlapenna/agent-lcars/')
with open(os.environ['FIXTURE_ROUTES']) as f: routes=json.load(f)
if route.startswith('compare/'):
    base, head = route.removeprefix('compare/').split('...')
    order=[os.environ['FIXTURE_BASE'], os.environ['FIXTURE_OLD'], os.environ['FIXTURE_NEW']]
    status='identical' if base==head else ('ahead' if base in order and head in order and order.index(base)<order.index(head) else ('behind' if base in order and head in order else 'diverged'))
    print(json.dumps({'status': status}))
elif route.startswith('actions/workflows/deploy-console.yml/runs?'):
    with open(os.environ['FIXTURE_RUNS']) as f: runs=json.load(f)
    query=dict(p.split('=',1) for p in route.split('?',1)[1].split('&'))
    created=query.get('created')
    if created is None:
        rows = runs['newer'] + runs['rows']
        total = runs['total'] + len(runs['newer'])
    elif created.startswith('%3E'):
        rows, total = runs['newer'], len(runs['newer'])
    else:
        # GitHub's search-filter behavior: total_count reports every match,
        # but only the first 1,000 results are ever returned.
        rows = runs['rows'] if created.startswith('%3C') else []
        total = len(rows) if created.startswith('%3C') else 0
        rows = rows[:1000]
    page=int(query.get('page','1'))
    print(json.dumps({'total_count': total, 'workflow_runs': rows[(page-1)*100:page*100]}))
else: print(json.dumps(routes[route]))
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync('bash', ['-c', guard.run!], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        EVENT_NAME: event,
        DELIVERY_MODE: deliveryMode,
        SOURCE_SHA: source,
        GITHUB_REPOSITORY: 'jlapenna/agent-lcars',
        GITHUB_RUN_ID: '999',
        GITHUB_OUTPUT: output,
        GH_TOKEN: 'fixture-only',
        FIXTURE_CALLS: calls,
        FIXTURE_ROUTES: path.join(dir, 'routes'),
        FIXTURE_RUNS: path.join(dir, 'runs'),
        FIXTURE_FAIL: String(fail),
        FIXTURE_BASE: BASE,
        FIXTURE_OLD: OLD,
        FIXTURE_NEW: NEW,
      },
    });
    return {
      status: result.status,
      output: readFileSync(output, 'utf8').match(/^deploy_current=(.*)$/m)?.[1],
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function executes(
  step: Step,
  current: string | undefined,
  mode = 'managed',
  version = 'build-123',
) {
  return (
    step.if === undefined ||
    runInNewContext(
      step.if,
      {
        steps: {
          source: { outputs: { deploy_current: current } },
          release: { outputs: { version } },
        },
        inputs: { build_mode: mode },
      },
      { timeout: 100 },
    ) === true
  );
}

describe('serialized automatic deployment source fence', () => {
  it('retains latest B behind active X when delayed eligible A arrives', () => {
    // GitHub defaults to replacing a single pending job. queue:max retains
    // up to 100, FIFO by admission time. X owns the active slot throughout
    // both admissions; neither later job can run its guard before X ends.
    const concurrency = workflow.jobs.deploy.concurrency!;
    const pending: string[] = [];
    const canceled: string[] = [];
    for (const source of [NEW, OLD]) {
      if (concurrency.queue !== 'max') canceled.push(...pending.splice(0));
      pending.push(source);
    }
    expect(canceled).toEqual([]);
    const delivered = pending.filter(
      (source) => sourceDecision(source, NEW).output === 'true',
    );
    expect(delivered).toEqual([NEW]);
    expect(concurrency.group).toBe('deploy-console');
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('enforces the supported queue syntax covered by the narrow actionlint compatibility exception', () => {
    // The pinned linter predates concurrency.queue. Required contracts own
    // validation of this new key for the one exceptional workflow only.
    for (const concurrency of [
      workflow.concurrency,
      ...Object.values(workflow.jobs).map((job) => job.concurrency),
    ]) {
      if (concurrency === undefined || !('queue' in concurrency)) continue;
      expect(['single', 'max']).toContain(concurrency.queue);
      expect(
        concurrency.queue === 'max' &&
          ![undefined, false].includes(
            concurrency['cancel-in-progress'] as undefined | boolean,
          ),
      ).toBe(false);
    }
    const config = parse(readFileSync('.github/actionlint.yaml', 'utf8'));
    expect(config.paths).toEqual({
      '.github/workflows/deploy-console.yml': {
        ignore: [
          '^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$',
        ],
      },
    });
  });

  it.each(['delayed older gate', 'older CI completes last'])(
    'prevents rollback when %s after a newer source deployed',
    () => {
      // Each invocation represents acquisition of the SAME deploy lock.
      // The newer source owns the main tip before both possible arrivals.
      const delivered: string[] = [];
      for (const source of [NEW, OLD]) {
        if (sourceDecision(source, NEW).output === 'true')
          delivered.push(source);
      }
      expect(delivered).toEqual([NEW]);
    },
  );

  it('allows a tip source and preserves explicit manual old-source semantics', () => {
    expect(workflow.jobs.deploy.steps[0]?.id).toBe('source');
    expect(sourceDecision(NEW, NEW)).toMatchObject({
      status: 0,
      output: 'true',
    });
    expect(sourceDecision(OLD, NEW, 'workflow_dispatch', true)).toEqual({
      status: 0,
      output: 'true',
      calls: '',
    });
  });

  it('deploys a validated ancestor while newer main is still waiting for CI', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [{ source: BASE }]),
    ).toMatchObject({ status: 0, output: 'true' });
  });

  it('rejects an old automatic source after a newer manual rollout even when serving verification failed', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: NEW, verify: 'failure' },
      ]),
    ).toMatchObject({ status: 0, output: 'false' });
  });

  it('treats a failed rollout command as a possible production effect', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: NEW, conclusion: 'failure' },
      ]),
    ).toMatchObject({ status: 0, output: 'false' });
  });

  it('retains a newer cancelled possible effect after an older successful rollout', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: OLD },
        {
          source: NEW,
          conclusion: 'cancelled',
          updated: '2026-10-13T02:00:00Z',
          end: '2026-10-13T02:00:00Z',
        },
      ]),
    ).toMatchObject({ status: 0, output: 'false' });
  });

  it('ignores successful skipped workflows and their misleading displayed main SHA', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: NEW, conclusion: 'skipped' },
        { source: OLD },
      ]),
    ).toMatchObject({ status: 0, output: 'true' });
  });

  it('reads newer rollback evidence beyond the first 100 history records', () => {
    const earlier = Array.from({ length: 100 }, () => ({
      source: OLD,
      updated: '2026-10-12T23:00:00Z',
      end: '2026-10-12T23:00:00Z',
    }));
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        ...earlier,
        { source: NEW },
      ]),
    ).toMatchObject({ status: 0, output: 'false' });
  });

  it('includes actual rollout evidence from older rerun attempts', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        {
          source: NEW,
          attempts: [{ conclusion: 'success' }, { conclusion: 'skipped' }],
        },
      ]),
    ).toMatchObject({ status: 0, output: 'false' });
  });

  it('fails closed for incomplete history, unknown effect provenance and incomparable sources', () => {
    expect(
      sourceDecision(
        NEW,
        NEW,
        'workflow_run',
        false,
        '',
        [{ source: OLD }],
        true,
      ).status,
    ).not.toBe(0);
    expect(
      sourceDecision(NEW, NEW, 'workflow_run', false, '', [
        { marker: 'legacy no source' },
      ]).status,
    ).not.toBe(0);
    expect(
      sourceDecision(NEW, NEW, 'workflow_run', false, '', [
        { source: 'c'.repeat(40) },
      ]).status,
    ).not.toBe(0);
    expect(sourceDecision('c'.repeat(40), NEW).status).not.toBe(0);
  }, 20000);

  it('reads history at a creation ceiling so concurrent new runs cannot change the scan', () => {
    const call = sourceDecision(
      OLD,
      NEW,
      'workflow_run',
      false,
      '',
      [{ source: NEW }],
      false,
      { newer: 150 },
    );
    expect(call).toMatchObject({ status: 0, output: 'false' });
  });

  it('reads complete history beyond the 1,000-result cap of a filtered listing', () => {
    // Run 38438235710: `created=<=` returned 1,000 of 2,500 runs, so every
    // scan was incomplete and each automatic deployment refused.
    const call = sourceDecision(
      OLD,
      NEW,
      'workflow_run',
      false,
      '',
      [{ source: NEW }],
      false,
      { newer: 3 },
      1200,
    );
    expect(call).toMatchObject({ status: 0, output: 'false' });
  });

  it('refuses terminal rollout evidence without its start or step inventory', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: NEW, missingStart: true },
      ]).status,
    ).not.toBe(0);
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: NEW, missingSteps: true },
      ]).status,
    ).not.toBe(0);
  });

  it('excludes earlier legacy evidence only after a proved later successful rollout', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: OLD },
        {
          marker: 'legacy unknown',
          updated: '2026-10-12T23:00:00Z',
          end: '2026-10-12T23:00:00Z',
        },
      ]),
    ).toMatchObject({ status: 0, output: 'true' });
    // Equality is not an earlier bound: retain unknown evidence at T.
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: OLD },
        { marker: 'legacy unknown' },
      ]).status,
    ).not.toBe(0);
  });

  it('parses timestamps by instant and refuses a run timestamp older than its effect', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: OLD, updated: '2026-10-13T03:00:00+02:00' },
      ]),
    ).toMatchObject({ status: 0, output: 'true' });
    expect(
      sourceDecision(OLD, NEW, 'workflow_run', false, '', [
        { source: OLD, updated: '2026-10-13T00:59:59Z' },
      ]).status,
    ).not.toBe(0);
  });

  it.each(['', 'not-a-sha', 'c'.repeat(39)])(
    'fails closed for unreadable main %j',
    (main) => {
      const result = sourceDecision(NEW, main);
      expect(result.status).not.toBe(0);
      expect(result.output).not.toBe('true');
    },
  );

  it('fails closed for a main API error and malformed automatic source', () => {
    expect(sourceDecision(NEW, NEW, 'workflow_run', true).status).not.toBe(0);
    expect(sourceDecision('bad-source', NEW).output).not.toBe('true');
  });

  it('fences automatic recovered-ci dispatches while ordinary manual dispatch bypasses the lookup', () => {
    expect(
      sourceDecision(OLD, NEW, 'workflow_dispatch', false, 'recovered-ci'),
    ).toMatchObject({ status: 0, output: 'false' });
    expect(
      sourceDecision(NEW, NEW, 'workflow_dispatch', false, 'recovered-ci'),
    ).toMatchObject({ status: 0, output: 'true' });
    expect(
      sourceDecision(NEW, NEW, 'workflow_dispatch', true, 'recovered-ci')
        .status,
    ).not.toBe(0);
  });

  it.each(['false', undefined])(
    'skips every later step for source output %s',
    (output) => {
      const later =
        guard === undefined
          ? workflow.jobs.deploy.steps
          : workflow.jobs.deploy.steps.slice(1);
      expect(later.length).toBeGreaterThan(0);
      for (const step of later) {
        expect({
          step: step.name ?? step.uses,
          executes: executes(step, output, 'managed'),
        }).toMatchObject({ executes: false });
        expect({
          step: step.name ?? step.uses,
          executes: executes(step, output, 'prebuilt'),
        }).toMatchObject({ executes: false });
      }
    },
  );

  it('keeps the build path and missing-version annotation conditions after admission', () => {
    const steps = workflow.jobs.deploy.steps;
    const managed = steps.find((step) => step.id === 'managed')!;
    const prebuilt = steps.find((step) => step.id === 'prebuilt')!;
    const annotation = steps.find((step) => step.name?.startsWith('Annotate'))!;
    expect(executes(managed, 'true', 'managed')).toBe(true);
    expect(executes(managed, 'true', 'prebuilt')).toBe(false);
    expect(executes(prebuilt, 'true', 'managed')).toBe(false);
    expect(executes(prebuilt, 'true', 'prebuilt')).toBe(true);
    expect(executes(annotation, 'true', 'managed', '')).toBe(false);
  });
});
