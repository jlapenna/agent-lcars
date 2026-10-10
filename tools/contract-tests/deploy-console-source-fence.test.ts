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
const workflow = parse(
  readFileSync('.github/workflows/deploy-console.yml', 'utf8'),
) as { jobs: { deploy: { steps: Step[] } } };
const OLD = 'a'.repeat(40),
  NEW = 'b'.repeat(40);
const guard = workflow.jobs.deploy.steps.find((step) => step.id === 'source');

function sourceDecision(
  source: string,
  main: string,
  event = 'workflow_run',
  fail = false,
  deliveryMode = '',
) {
  // The old workflow has no source fence and admits every Verify-passed run.
  if (guard === undefined) return { status: 0, output: 'true', calls: '' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-source-fence-'));
  const output = path.join(dir, 'output'),
    calls = path.join(dir, 'calls');
  writeFileSync(output, '');
  writeFileSync(
    path.join(dir, 'gh'),
    `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
test "$*" = 'api repos/jlapenna/agent-lcars/git/ref/heads/main --jq .object.sha'
if [ "$FIXTURE_FAIL" = true ]; then exit 1; fi
printf '%s\\n' "$FIXTURE_MAIN"
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
        GITHUB_OUTPUT: output,
        GH_TOKEN: 'fixture-only',
        FIXTURE_CALLS: calls,
        FIXTURE_MAIN: main,
        FIXTURE_FAIL: String(fail),
      },
    });
    const lines = readFileSync(output, 'utf8');
    return {
      status: result.status,
      output: lines.match(/^deploy_current=(.*)$/m)?.[1],
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
