import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  if?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  name?: string;
  needs?: string[];
  steps?: Step[];
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  env: Record<string, string>;
  jobs: Record<string, Job>;
};
const shards = ['verify-full', 'verify-full-console'];
const verify = workflow.jobs.verify;

// Required CI check: pnpm check:contracts consumes this actual-workflow
// regression for #2341. A draft green summary must not replace full proof.
describe('required verification proof across draft readiness', () => {
  it.each([
    [0, 0, true],
    [1, 0, false],
    [0, 1, false],
    [1, 1, false],
  ])(
    'joins isolated direct-runner=%i and Firestore=%i as pass=%s',
    (direct, firestore, pass) => {
      const run = workflow.jobs['verify-full-console'].steps?.find((step) =>
        step.run?.includes('direct_runner_pid=$!'),
      )?.run;
      expect(run).toBeDefined();
      const root = mkdtempSync(path.join(tmpdir(), 'lcars-ci-join-'));
      try {
        const fixture = (name: string, other: string, status: number) =>
          `#!/usr/bin/env bash
set -euo pipefail
touch "${root}/${name}.started"
for _ in {1..100}; do
  if [[ -f "${root}/${other}.started" ]]; then break; fi
  sleep 0.01
done
[[ -f "${root}/${other}.started" ]] || exit 91
touch "${root}/${name}.finished"
exit ${status}
`;
        mkdirSync(path.join(root, 'apps/runner-autoscaler/runner-image'), {
          recursive: true,
        });
        mkdirSync(path.join(root, 'tools'));
        writeFileSync(
          path.join(
            root,
            'apps/runner-autoscaler/runner-image/direct-runner.test.sh',
          ),
          fixture('direct', 'firestore', direct),
        );
        writeFileSync(
          path.join(root, 'tools/nx'),
          fixture('firestore', 'direct', firestore),
          { mode: 0o755 },
        );
        let passed = true;
        try {
          execFileSync('bash', ['-e', '-c', run!], {
            cwd: root,
            timeout: 5000,
            stdio: 'pipe',
          });
        } catch {
          passed = false;
        }
        expect(passed).toBe(pass);
        expect(readFileSync(path.join(root, 'direct.finished'), 'utf8')).toBe(
          '',
        );
        expect(
          readFileSync(path.join(root, 'firestore.finished'), 'utf8'),
        ).toBe('');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('runs the full and Terraform checks on draft as well as ready revisions', () => {
    for (const shard of shards) {
      expect(workflow.jobs[shard].if).toBeUndefined();
      expect(verify.needs).toContain(shard);
    }
    expect(workflow.jobs.terraform.if).toBeUndefined();
    expect(verify.name).toBe('Verify');
    expect(verify.if).toBe('always()');
  });

  // #2082 split one serial job into two Nx project partitions. Dropping or
  // narrowing either side would silently remove coverage from `Verify`.
  it('partitions the one Nx task set between the shards without a gap', () => {
    const runMany = (job: string) =>
      (workflow.jobs[job].steps ?? [])
        .map((step) => step.run?.replace(/\s+/gu, ' ').trim() ?? '')
        .filter((run) => run.includes('nx run-many -t test'));
    const targets = './tools/nx run-many -t test typecheck build test-race';
    expect(workflow.env.NX_CONSOLE_SHARD_PROJECTS).toBe(
      '@agent-lcars/console,@agent-lcars/console-e2e',
    );
    expect(runMany('verify-full')).toEqual([
      `${targets} --all --exclude="$NX_CONSOLE_SHARD_PROJECTS" --parallel=2`,
    ]);
    expect(runMany('verify-full-console')).toEqual([
      `${targets} --projects="$NX_CONSOLE_SHARD_PROJECTS" --parallel=2`,
    ]);
  });

  it.each([
    ['success', 'success', 'success', 'success', true],
    ['skipped', 'success', 'success', 'success', false],
    ['failure', 'success', 'success', 'success', false],
    ['cancelled', 'success', 'success', 'success', false],
    ['', 'success', 'success', 'success', false],
    ['success', 'skipped', 'success', 'success', false],
    ['success', 'failure', 'success', 'success', false],
    ['success', 'cancelled', 'success', 'success', false],
    ['success', '', 'success', 'success', false],
    ['success', 'success', 'failure', 'success', false],
    ['success', 'success', 'skipped', 'success', false],
    ['success', 'success', 'success', 'failure', false],
    ['success', 'success', 'success', 'cancelled', false],
  ])(
    'consumes full=%s console=%s labels=%s schedules=%s as pass=%s',
    (full, consoleShard, labels, schedules, pass) => {
      const gates = verify.steps?.filter((step) => step.env && step.run) ?? [];
      const fullGate = gates.find((step) => step.env?.VERIFY_FULL_RESULT);
      expect(fullGate).toBeDefined();
      // Conditional omission of this step is the observed draft false success.
      expect(fullGate?.if).toBeUndefined();
      const results: Record<string, string> = {
        'needs.verify-full.result': full as string,
        'needs.verify-full-console.result': consoleShard as string,
        'needs.runner-labels.result': labels as string,
        'needs.schedules.result': schedules as string,
      };
      let passed = true;
      for (const step of gates) {
        expect(step.if).toBeUndefined();
        const env = Object.fromEntries(
          Object.entries(step.env!).map(([key, expression]) => {
            const reference = expression.match(
              /^\$\{\{\s*([^}]+?)\s*\}\}$/u,
            )?.[1];
            if (!reference || !(reference in results))
              throw new Error('unknown actual gate dependency');
            return [key, results[reference]];
          }),
        );
        try {
          execFileSync('bash', ['-e', '-c', step.run!], {
            env: { ...process.env, ...env },
            stdio: 'pipe',
          });
        } catch {
          passed = false;
          break;
        }
      }
      expect(passed).toBe(pass);
    },
  );
});
