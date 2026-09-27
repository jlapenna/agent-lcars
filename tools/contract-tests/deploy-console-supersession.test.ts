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

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();
const script = path.join(root, 'tools/deploy-console-superseded.sh');
const dirs: string[] = [];
const sha = (c: string) => c.repeat(40);

// Fake `gh api` for the three endpoints the script reads: successful
// deploy-console runs (newest first), each run's jobs, and compare status.
function run(
  runs: { id: number; source: string; deploy: string }[],
  compare: string,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-supersession-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'bin'));
  const jobs = runs
    .map((r) => `  */runs/${r.id}/jobs) echo ${r.deploy} ;;`)
    .join('\n');
  const listing = runs
    .map((r) => `${r.id} Deploy console [source:${r.source}]`)
    .join('\\n');
  writeFileSync(
    path.join(dir, 'bin/gh'),
    `#!/usr/bin/env bash
case "$2" in
  */workflows/deploy-console.yml/runs*) printf '${listing}\\n' ;;
${jobs}
  */compare/*) echo "$2" >> "${dir}/compared"; echo ${compare} ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = execFileSync('bash', [script, 'o/r', sha('c')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let compared = '';
  try {
    compared = readFileSync(path.join(dir, 'compared'), 'utf8');
  } catch {
    // no comparison made
  }
  return { output: result.trim(), compared };
}

afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);

describe('deploy-console supersession guard', () => {
  it.each([
    ['behind', 'superseded=true'],
    ['identical', 'superseded=true'],
    ['ahead', 'superseded=false'],
    ['diverged', 'superseded=false'],
  ])('compare status %s yields %s', (status, expected) => {
    expect(
      run([{ id: 1, source: sha('a'), deploy: 'success' }], status).output,
    ).toBe(expected);
  });

  it('measures against the newest run whose deploy job actually succeeded', () => {
    const { compared } = run(
      [
        { id: 3, source: sha('d'), deploy: 'skipped' },
        { id: 2, source: sha('e'), deploy: 'failure' },
        { id: 1, source: sha('a'), deploy: 'success' },
      ],
      'behind',
    );
    expect(compared.trim()).toBe(`repos/o/r/compare/${sha('a')}...${sha('c')}`);
  });

  it('deploys when no successful deploy exists', () => {
    expect(
      run([{ id: 1, source: sha('a'), deploy: 'skipped' }], 'behind'),
    ).toEqual({
      output: 'superseded=false',
      compared: '',
    });
  });

  it('fails closed on an unexpected compare status', () => {
    expect(() =>
      run([{ id: 1, source: sha('a'), deploy: 'success' }], 'weird'),
    ).toThrow();
  });
});

describe('concurrent main CI wiring', () => {
  const workflow = (name: string) =>
    parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8'));

  it('gives each main commit its own CI concurrency group', () => {
    expect(workflow('ci.yml').concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}",
    );
  });

  it('skips a superseded revision instead of deploying it', () => {
    const deploy = workflow('deploy-console.yml');
    expect(deploy.concurrency).toEqual({
      group: 'deploy-console',
      'cancel-in-progress': false,
    });
    expect(deploy.jobs.deploy.if).toContain(
      "needs.gate.outputs.superseded != 'true'",
    );
    expect(deploy.jobs.gate.outputs.superseded).toBe(
      '${{ steps.supersession.outputs.superseded }}',
    );
  });
});
