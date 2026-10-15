import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createRunner,
  main,
  renderSummary,
  resolveRunSpec,
  runAll,
  RunError,
  stepGithub,
  STEPS,
  stepTarget,
} from '../fleet-onboard-run.mjs';

type Call = { command: string; args: string[]; cwd?: string };
type Reply = { status?: number; stdout?: string; stderr?: string };

/** Fake executor: canned replies keyed by a predicate, every call recorded. */
function fakeExec(rules: Array<[(call: Call) => boolean, Reply]> = []) {
  const calls: Call[] = [];
  const exec = (
    command: string,
    args: string[],
    { cwd }: { cwd?: string } = {},
  ) => {
    const call = { command, args, cwd };
    calls.push(call);
    const rule = rules.find(([match]) => match(call));
    return { status: 0, stdout: '', stderr: '', ...(rule?.[1] ?? {}) };
  };
  return { exec, calls };
}

const quiet = (_line: string): void => undefined;

const has = (needle: string) => (call: Call) =>
  [call.command, ...call.args].join(' ').includes(needle);

function context(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const workdir = mkdtempSync(path.join(tmpdir(), 'fleet-onboard-run-'));
  // The target clone already exists, so the scaffold check runs.
  mkdirSync(path.join(workdir, 'project'));
  const spec = resolveRunSpec({
    repo: 'example/project',
    'runner-label': 'project-default',
    'ci-workflow': ['ci.yml'],
    'ci-checks': 'Unit tests',
    ...((overrides.options as Record<string, unknown>) ?? {}),
  });
  return {
    log,
    workdir,
    spec,
    root: '/repo/agent-lcars',
    toolsDir: '/repo/agent-lcars/tools',
    homelab: (overrides.homelab as string) ?? '/nonexistent/homelab',
  };
}

describe('resolveRunSpec', () => {
  it('validates repositories and step names', () => {
    expect(() => resolveRunSpec({ repo: 'nope' })).toThrow(RunError);
    expect(() => resolveRunSpec({ repo: 'a/b', skip: ['nonsense'] })).toThrow(
      RunError,
    );
    const spec = resolveRunSpec({
      repo: 'a/b',
      skip: ['homelab,github'],
      'ci-workflow': ['ci.yml,lint.yml'],
    });
    expect([...spec.skip]).toEqual(['homelab', 'github']);
    expect(spec.ciWorkflows).toEqual(['ci.yml', 'lint.yml']);
    expect(spec.copyFrom).toBe('jlapenna/sync-padd');
  });
});

describe('dry run', () => {
  it('performs no mutating command and reports a plan for every step', () => {
    const ctx = context();
    const { exec, calls } = fakeExec([
      // scaffold --check reports drift on a target that is not onboarded.
      [has('fleet-onboard.mjs scaffold'), { status: 1 }],
      [has('fleet-onboard.mjs admit'), { status: 1 }],
      [
        has('fleet-onboard-github.mjs'),
        {
          stdout: [
            JSON.stringify({
              fact: 'variable:AGENT_FLEET_LOGIN',
              status: 'PLAN',
            }),
            JSON.stringify({
              fact: 'installation:fleet',
              status: 'UNVERIFIED',
              detail: 'credential absent',
            }),
          ].join('\n'),
        },
      ],
    ]);
    const run = createRunner({
      exec,
      dryRun: true,
      log: (l: string) => ctx.log.push(l),
    });
    const results = runAll({
      ...ctx,
      run,
      log: (l: string) => ctx.log.push(l),
    });

    expect(results.target.status).toBe('planned');
    expect(results.lcars.status).toBe('planned');
    expect(results.homelab.status).toBe('blocked');
    expect(results.github.status).toBe('done');
    expect(results.github.human[0]).toBe(
      'installation:fleet: credential absent',
    );
    // Not admitted in this checkout's manifest: labels are deferred, not failed.
    expect(results.github.human[1]).toContain('sync-github-labels.mjs');
    const github = calls.find(has('fleet-onboard-github.mjs'));
    expect(github?.args).toContain('--skip-labels');

    const mutating = calls.filter(
      (call) =>
        (call.command === 'git' &&
          ['commit', 'push', 'checkout', 'worktree', 'add'].includes(
            call.args[0],
          )) ||
        (call.command === 'gh' &&
          ['create', 'clone'].includes(call.args[1] ?? '')),
    );
    expect(mutating).toEqual([]);
    expect(ctx.log.some((line) => line.startsWith('would-run\t'))).toBe(true);
    // Scaffold options are forwarded verbatim, with --check appended.
    const scaffold = calls.find(has('fleet-onboard.mjs scaffold'));
    expect(scaffold?.args).toEqual(
      expect.arrayContaining([
        '--repo',
        'example/project',
        '--runner-label',
        'project-default',
        '--ci-workflow',
        'ci.yml',
        '--ci-checks',
        'Unit tests',
        '--check',
      ]),
    );
    // The GitHub helper receives --dry-run and the copy-from source.
    expect(github?.args).toEqual(
      expect.arrayContaining([
        '--copy-from',
        'jlapenna/sync-padd',
        '--dry-run',
      ]),
    );
  });
});

describe('resumability', () => {
  it('treats an open pull request on the step branch as done', () => {
    const ctx = context();
    const prList = (url: string) => ({
      stdout: JSON.stringify([{ number: 7, url, isDraft: true }]),
    });
    const { exec, calls } = fakeExec([
      [
        (call) => has('pr list')(call) && call.args.includes('example/project'),
        prList('https://github.com/example/project/pull/7'),
      ],
      [
        (call) =>
          has('pr list')(call) && call.args.includes('jlapenna/agent-lcars'),
        prList('https://github.com/jlapenna/agent-lcars/pull/9'),
      ],
    ]);
    const run = createRunner({ exec, dryRun: false, log: quiet });
    const results = runAll({
      ...ctx,
      run,
      spec: { ...ctx.spec, skip: new Set(['homelab', 'github']) },
      log: quiet,
    });
    expect(results.target).toMatchObject({
      status: 'done',
      url: 'https://github.com/example/project/pull/7',
    });
    expect(results.lcars).toMatchObject({
      status: 'done',
      url: 'https://github.com/jlapenna/agent-lcars/pull/9',
    });
    expect(results.homelab.status).toBe('skipped');
    expect(calls.some(has('repo clone'))).toBe(false);
    expect(calls.some(has('worktree add'))).toBe(false);
  });

  it('blocks the Homelab step until the helper is on main', () => {
    const homelab = mkdtempSync(path.join(tmpdir(), 'homelab-'));
    // A directory with a .git marker but no helper on origin/main.
    const ctx = context({ homelab });
    const { exec } = fakeExec([[has('cat-file -e'), { status: 1 }]]);
    const run = createRunner({ exec, dryRun: true, log: quiet });
    const results = runAll({
      ...ctx,
      run,
      spec: { ...ctx.spec, skip: new Set(['target', 'lcars', 'github']) },
      log: quiet,
    });
    expect(results.homelab.status).toBe('blocked');
    expect(results.homelab.detail).toContain('no Homelab checkout');
  });

  it('turns a failing step into a failed result and keeps going', () => {
    const ctx = context();
    const { exec } = fakeExec([
      [has('fleet-onboard.mjs scaffold'), { status: 2, stderr: 'bad input' }],
      [has('fleet-onboard-github.mjs'), { status: 0 }],
    ]);
    const run = createRunner({ exec, dryRun: true, log: quiet });
    const results = runAll({
      ...ctx,
      run,
      spec: { ...ctx.spec, skip: new Set(['lcars', 'homelab']) },
      log: quiet,
    });
    expect(results.target.status).toBe('failed');
    expect(results.target.detail).toContain('scaffold failed');
    expect(results.github.status).toBe('done');
  });
});

describe('summary and CLI', () => {
  it('lists every step and the remaining human actions', () => {
    const spec = resolveRunSpec({ repo: 'example/project' });
    const summary = renderSummary(spec, {
      target: { status: 'done', detail: 'https://x/1' },
      lcars: { status: 'done', detail: 'https://x/2' },
      homelab: { status: 'blocked', detail: 'helper missing' },
      github: {
        status: 'attention',
        detail: '7 facts',
        human: ['installation:autoscaler: add it in the UI'],
      },
    });
    for (const step of STEPS) expect(summary).toContain(`- ${step}:`);
    expect(summary).toContain('installation:autoscaler: add it in the UI');
    expect(summary).toContain('verify-onboarding.mjs --repo=example/project');
  });

  it('exits 1 when any step is blocked and 0 when all are done', () => {
    const log: string[] = [];
    const cliWorkdir = mkdtempSync(
      path.join(tmpdir(), 'fleet-onboard-run-cli-'),
    );
    mkdirSync(path.join(cliWorkdir, 'project'));
    const { exec } = fakeExec([
      [has('fleet-onboard.mjs scaffold'), { status: 0 }],
      [has('fleet-onboard.mjs admit'), { status: 0 }],
      [has('fleet-onboard-github.mjs'), { status: 0 }],
    ]);
    const code = main(
      [
        '--repo',
        'example/project',
        '--dry-run',
        '--skip',
        'homelab',
        '--workdir',
        cliWorkdir,
      ],
      { root: '/repo/agent-lcars', exec, log: (l: string) => log.push(l) },
    );
    expect(code).toBe(0);
    expect(log.join('\n')).toContain('target\tunchanged');

    const blocked = main(
      ['--repo', 'example/project', '--dry-run', '--homelab', '/nonexistent'],
      { root: '/repo/agent-lcars', exec, log: quiet },
    );
    expect(blocked).toBe(1);
  });
});

describe('apply path', () => {
  it('stages with git add -A, bases on the real default branch, and opens the PR', () => {
    const ctx = context();
    const { exec, calls } = fakeExec([
      [has('pr list'), { stdout: '[]' }],
      [has('repo view'), { stdout: 'trunk\n' }],
      [has('fleet-onboard.mjs scaffold'), { status: 0 }],
      [has('diff --cached --quiet'), { status: 1 }],
      [
        has('pr create'),
        { stdout: 'https://github.com/example/project/pull/3\n' },
      ],
    ]);
    const run = createRunner({ exec, dryRun: false, log: quiet });
    const result = stepTarget({ ...ctx, run, log: quiet });
    expect(result).toMatchObject({
      status: 'done',
      url: 'https://github.com/example/project/pull/3',
    });
    const add = calls.find(
      (call) => call.command === 'git' && call.args[0] === 'add',
    );
    expect(add?.args).toEqual(['add', '-A']);
    expect(calls.find(has('checkout -q -B'))?.args).toContain('origin/trunk');
    const scaffold = calls.find(has('fleet-onboard.mjs scaffold'));
    expect(scaffold?.args).toEqual(
      expect.arrayContaining(['--default-branch', 'trunk']),
    );
    expect(scaffold?.args).not.toContain('--check');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ])(
    'updates %s before committing a new Husky dependency',
    (lockfile, manager) => {
      const ctx = context();
      const clone = path.join(ctx.workdir, 'project');
      const pkg = path.join(clone, 'package.json');
      writeFileSync(pkg, '{"name":"project"}\n');
      writeFileSync(path.join(clone, lockfile), 'old lock');
      const { exec, calls } = fakeExec([
        [has('diff --cached --quiet'), { status: 1 }],
        [
          has('pr create'),
          { stdout: 'https://github.com/example/project/pull/3\n' },
        ],
      ]);
      const committedLocks: string[] = [];
      const run = createRunner({
        dryRun: false,
        log: quiet,
        exec: (command, args, options) => {
          if (has('fleet-onboard.mjs scaffold')({ command, args }))
            writeFileSync(
              pkg,
              '{"name":"project","devDependencies":{"@jlapenna/repo-tools":"github:jlapenna/repo-tools#v2.0.8"}}\n',
            );
          if (command === manager && args[0] === 'install')
            writeFileSync(
              path.join(clone, lockfile),
              'lock includes repo-tools',
            );
          if (command === 'git' && args[0] === 'commit')
            committedLocks.push(
              readFileSync(path.join(clone, lockfile), 'utf8'),
            );
          return exec(command, args, options);
        },
      });
      expect(stepTarget({ ...ctx, run, log: quiet }).status).toBe('done');
      expect(committedLocks).toEqual(['lock includes repo-tools']);
      expect(
        calls
          .filter((call) => call.command === manager)
          .map((call) => call.args),
      ).toEqual([['install']]);
    },
  );

  it('does not commit or push when installing the scaffold dependency fails', () => {
    const ctx = context();
    const pkg = path.join(ctx.workdir, 'project', 'package.json');
    writeFileSync(pkg, '{"name":"project"}\n');
    const { exec, calls } = fakeExec([
      [has('npm install'), { status: 1, stderr: 'registry unavailable' }],
    ]);
    const run = createRunner({
      dryRun: false,
      log: quiet,
      exec: (command, args, options) => {
        if (has('fleet-onboard.mjs scaffold')({ command, args }))
          writeFileSync(
            pkg,
            '{"name":"project","devDependencies":{"@jlapenna/repo-tools":"github:jlapenna/repo-tools#v2.0.8"}}\n',
          );
        return exec(command, args, options);
      },
    });
    expect(() => stepTarget({ ...ctx, run, log: quiet })).toThrow(
      /npm install exited 1/,
    );
    expect(
      calls.some(
        (call) =>
          call.command === 'git' && ['commit', 'push'].includes(call.args[0]),
      ),
    ).toBe(false);
  });

  it('does not stage installed dependency files when the target lacks an ignore rule', () => {
    const ctx = context();
    const clone = path.join(ctx.workdir, 'project');
    const pkg = path.join(clone, 'package.json');
    execFileSync('git', ['init', '--quiet', clone]);
    execFileSync('git', [
      '-C',
      clone,
      'config',
      'core.excludesFile',
      '/dev/null',
    ]);
    writeFileSync(pkg, '{"name":"project"}\n');
    const { exec, calls } = fakeExec();
    const run = createRunner({
      dryRun: false,
      log: quiet,
      exec: (command, args, options) => {
        if (has('fleet-onboard.mjs scaffold')({ command, args }))
          writeFileSync(
            pkg,
            '{"name":"project","devDependencies":{"@jlapenna/repo-tools":"github:jlapenna/repo-tools#v2.0.8"}}\n',
          );
        if (command === 'npm' && args[0] === 'install') {
          mkdirSync(path.join(clone, 'node_modules', 'installed'), {
            recursive: true,
          });
          writeFileSync(
            path.join(clone, 'node_modules', 'installed', 'package.json'),
            '{}',
          );
        }
        const result = exec(command, args, options);
        if (command === 'git' && args[0] === 'ls-files')
          return {
            ...result,
            stdout: execFileSync(command, args, {
              cwd: clone,
              encoding: 'utf8',
            }),
          };
        return result;
      },
    });
    expect(() => stepTarget({ ...ctx, run, log: quiet })).toThrow(
      /unignored node_modules/,
    );
    expect(
      calls.some(
        (call) =>
          call.command === 'git' &&
          ['add', 'commit', 'push'].includes(call.args[0]),
      ),
    ).toBe(false);
  });

  it('runs the GitHub helper from the admission worktree once it lists the repo', () => {
    const ctx = context();
    const worktree = mkdtempSync(path.join(tmpdir(), 'lcars-admit-'));
    mkdirSync(path.join(worktree, 'tools'));
    mkdirSync(path.join(worktree, 'config'));
    writeFileSync(
      path.join(worktree, 'config', 'github-labels.json'),
      JSON.stringify({ repositories: { 'example/project': { labels: [] } } }),
    );
    const { exec, calls } = fakeExec([
      [has('fleet-onboard-github.mjs'), { stdout: '' }],
    ]);
    const run = createRunner({ exec, dryRun: false, log: quiet });
    const result = stepGithub({
      ...ctx,
      run,
      log: quiet,
      copyFrom: ctx.spec.copyFrom,
      lcarsWorktree: worktree,
    });
    const helper = calls.find(has('fleet-onboard-github.mjs'));
    expect(helper?.args[0]).toBe(
      path.join(worktree, 'tools', 'fleet-onboard-github.mjs'),
    );
    expect(helper?.args).not.toContain('--skip-labels');
    expect(result.human).toEqual([]);
  });
});
