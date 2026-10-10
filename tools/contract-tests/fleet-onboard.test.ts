import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  applyAdmit,
  applyScaffold,
  BASELINE_CHECKS,
  GUARDRAIL_COMMAND,
  main,
  MANAGED_MARKER,
  membershipGaps,
  mergeGuardrailHooks,
  OnboardError,
  planAdmit,
  planScaffold,
  readMembership,
  resolveSpec,
} from '../fleet-onboard.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const PROJECTIONS = [
  'config/github-labels.json',
  'apps/console/apphosting.yaml',
  '.github/workflows/label-contract-audit.yml',
];
const REV = 'dfa52a3f412126186b0466e83b2fe13cfce3c513';

function scratch(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

function write(root: string, file: string, content: string) {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, file: string) {
  return readFileSync(path.join(root, file), 'utf8');
}

function spec(overrides: Record<string, string> = {}) {
  return resolveSpec({
    repo: 'example/project',
    'repo-tools-rev': REV,
    ...overrides,
  });
}

function scaffold(target: string, options: Record<string, string> = {}) {
  const plan = planScaffold(target, spec(options));
  return { plan, results: applyScaffold(target, plan, {}) };
}

describe('fleet membership projections', () => {
  // docs/onboarding-repo.md: a manifest entry without a matrix entry is never
  // reconciled, and the console fails closed when its two lists disagree.
  // Every projection of fleet membership must therefore name the same set.
  it('name the same repositories everywhere', () => {
    const membership = readMembership(repoRoot);
    expect(membership.controlPlane.length).toBeGreaterThan(0);
    expect(membershipGaps(membership)).toEqual({});
  });

  it('report the projection a repository is missing from', () => {
    expect(
      membershipGaps({
        labels: ['a/b', 'c/d'],
        controlPlane: ['a/b'],
        watched: ['a/b'],
        audit: ['a/b', 'c/d'],
      }),
    ).toEqual({ controlPlane: ['c/d'], watched: ['c/d'] });
  });
});

describe('admit', () => {
  function copyProjections() {
    const root = scratch('fleet-onboard-root');
    for (const file of PROJECTIONS) write(root, file, read(repoRoot, file));
    return root;
  }

  it('adds a repository to every projection once', () => {
    const root = copyProjections();
    const edits = planAdmit(
      root,
      spec({ alias: 'proj' }),
      'jlapenna/sync-padd',
    );
    expect(edits.map((edit) => edit.file).sort()).toEqual(
      [...PROJECTIONS].sort(),
    );
    applyAdmit(root, edits, {});

    const membership = readMembership(root);
    expect(membershipGaps(membership)).toEqual({});
    expect(membership.audit).toContain('example/project');
    const labels = JSON.parse(read(root, PROJECTIONS[0])).repositories;
    expect(labels['example/project']).toEqual(labels['jlapenna/sync-padd']);
    const watched = JSON.parse(
      parseYaml(read(root, PROJECTIONS[1])).env.find(
        (entry: { variable: string }) =>
          entry.variable === 'AGENT_LCARS_WATCHED_REPOS',
      ).value,
    );
    expect(watched.at(-1)).toEqual({
      owner: 'example',
      name: 'project',
      alias: 'proj',
    });

    expect(planAdmit(root, spec(), 'jlapenna/sync-padd')).toEqual([]);
    const log: string[] = [];
    expect(main(['check'], { root, log: (line) => log.push(line) })).toBe(0);
  });

  it('refuses a repository present in only one console list', () => {
    const root = copyProjections();
    const file = PROJECTIONS[1];
    write(
      root,
      file,
      read(root, file).replace(
        "jlapenna/sync-padd'",
        "jlapenna/sync-padd,example/project'",
      ),
    );
    expect(() => planAdmit(root, spec(), 'jlapenna/sync-padd')).toThrow(
      OnboardError,
    );
  });

  it('check mode reports gaps without writing', () => {
    const root = copyProjections();
    const before = PROJECTIONS.map((file) => read(root, file));
    const log: string[] = [];
    expect(
      main(['admit', '--repo', 'example/project', '--check'], {
        root,
        log: (line) => log.push(line),
      }),
    ).toBe(1);
    expect(log.filter((line) => line.startsWith('missing\t'))).toHaveLength(3);
    expect(PROJECTIONS.map((file) => read(root, file))).toEqual(before);
  });
});

describe('scaffold', () => {
  it('creates the fleet surface and is idempotent', () => {
    const target = scratch('fleet-onboard-target');
    const { plan, results } = scaffold(target, {
      'runner-label': 'project-default',
      'ci-workflow': 'ci.yml',
      'ci-checks': 'Unit tests,Build',
    });
    expect(plan.hooks).toBe('pre-commit');
    expect(results.every((result) => result.action === 'create')).toBe(true);

    const automerge = parseYaml(
      read(target, '.github/workflows/agent-automerge.yml'),
    );
    expect(automerge.on.workflow_run.workflows).toEqual([
      'CI',
      'validate',
      'gitleaks',
      'ruleset',
    ]);
    expect(JSON.parse(automerge.jobs.automerge.with['runs-on'])).toEqual([
      'project-default',
    ]);
    expect(
      JSON.parse(automerge.jobs.automerge.with['required-checks']),
    ).toEqual([...BASELINE_CHECKS, 'Unit tests', 'Build']);
    expect(
      parseYaml(read(target, '.github/actionlint.yaml'))['self-hosted-runner']
        .labels,
    ).toEqual(['project-default']);
    const gitleaks = parseYaml(read(target, '.github/workflows/gitleaks.yml'));
    expect(gitleaks.jobs.gitleaks['runs-on']).toContain('project-default');
    expect(gitleaks.jobs.gitleaks['runs-on']).toContain('ubuntu-latest');

    const tf = read(target, 'infra/github-ruleset/main.tf');
    expect(tf).toContain('owner = "example"');
    expect(tf).toContain('repository  = "project"');
    for (const context of [...BASELINE_CHECKS, 'Unit tests', 'Build'])
      expect(tf).toContain(`context = "${context}"`);
    expect(read(target, '.pre-commit-config.yaml')).toContain(`rev: ${REV}`);
    expect(read(target, 'AGENTS.md')).toContain('<!-- fleet-onboard:begin -->');

    const again = scaffold(target, {
      'runner-label': 'project-default',
      'ci-workflow': 'ci.yml',
      'ci-checks': 'Unit tests,Build',
    });
    expect(again.results.every((result) => result.action === 'unchanged')).toBe(
      true,
    );
    expect(again.results.some((result) => result.drift)).toBe(false);
  });

  it('defaults to GitHub-hosted glue with the baseline checks only', () => {
    const target = scratch('fleet-onboard-target');
    const { plan } = scaffold(target);
    expect(plan.actions.map((action) => action.file)).not.toContain(
      '.github/actionlint.yaml',
    );
    const automerge = parseYaml(
      read(target, '.github/workflows/agent-automerge.yml'),
    );
    expect(automerge.on.workflow_run.workflows).toEqual([
      'validate',
      'gitleaks',
      'ruleset',
    ]);
    expect(JSON.parse(automerge.jobs.automerge.with['runs-on'])).toEqual([
      'ubuntu-latest',
    ]);
    expect(
      JSON.parse(automerge.jobs.automerge.with['required-checks']),
    ).toEqual([...BASELINE_CHECKS]);
    expect(
      parseYaml(read(target, '.github/workflows/gitleaks.yml')).jobs.gitleaks[
        'runs-on'
      ],
    ).toBe('ubuntu-latest');
  });

  it('merges hooks and sections into existing files without clobbering them', () => {
    const target = scratch('fleet-onboard-target');
    write(
      target,
      '.claude/settings.json',
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [] }] },
      }),
    );
    write(target, 'AGENTS.md', '# Project\n\nLocal rules.\n');
    write(
      target,
      '.pre-commit-config.yaml',
      'repos:\n  - repo: https://github.com/pre-commit/pre-commit-hooks\n    rev: v5.0.0\n    hooks:\n      - id: check-yaml\n',
    );
    scaffold(target);

    const settings = JSON.parse(read(target, '.claude/settings.json'));
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe(
      GUARDRAIL_COMMAND,
    );
    const agents = read(target, 'AGENTS.md');
    expect(agents.startsWith('# Project\n\nLocal rules.\n')).toBe(true);
    expect(agents.match(/fleet-onboard:begin/g)).toHaveLength(1);
    const preCommit = parseYaml(read(target, '.pre-commit-config.yaml'));
    expect(preCommit.repos.map((repo: { repo: string }) => repo.repo)).toEqual([
      'https://github.com/jlapenna/repo-tools',
      'https://github.com/pre-commit/pre-commit-hooks',
    ]);
    expect(
      mergeGuardrailHooks(read(target, '.claude/settings.json'), 'Bash'),
    ).toBe(read(target, '.claude/settings.json'));
  });

  it('leaves locally owned files alone unless forced', () => {
    const target = scratch('fleet-onboard-target');
    write(target, '.github/workflows/gitleaks.yml', 'name: custom\n');
    write(target, 'renovate.json', '{"extends":["local"]}\n');
    const first = planScaffold(target, spec());
    const results = applyScaffold(target, first, { check: true });
    const byFile = Object.fromEntries(
      results.map((result) => [result.file, result]),
    );
    expect(byFile['.github/workflows/gitleaks.yml'].action).toBe(
      'locally-owned',
    );
    expect(byFile['.github/workflows/gitleaks.yml'].drift).toBe(false);
    expect(byFile['renovate.json'].action).toBe('keep');
    expect(byFile['.github/workflows/validate.yml'].drift).toBe(true);
    expect(read(target, '.github/workflows/gitleaks.yml')).toBe(
      'name: custom\n',
    );

    applyScaffold(target, first, { force: true });
    expect(read(target, '.github/workflows/gitleaks.yml')).toContain(
      MANAGED_MARKER,
    );
    expect(read(target, 'renovate.json')).toBe('{"extends":["local"]}\n');

    write(
      target,
      '.github/workflows/gitleaks.yml',
      `# ${MANAGED_MARKER}\nstale\n`,
    );
    const refreshed = planScaffold(target, spec());
    expect(
      refreshed.actions.find(
        (action) => action.file === '.github/workflows/gitleaks.yml',
      )?.action,
    ).toBe('update');
  });

  it('seeds Husky hooks for Node repositories without pre-commit', () => {
    const target = scratch('fleet-onboard-target');
    write(target, 'package.json', '{"name":"x"}\n');
    write(target, '.husky/pre-commit', '#!/bin/sh\npnpm lint\n');
    const { plan } = scaffold(target);
    expect(plan.hooks).toBe('husky');
    expect(plan.actions.map((action) => action.file)).toContain(
      '.husky/pre-push',
    );
    expect(plan.actions.map((action) => action.file)).not.toContain(
      '.husky/pre-commit',
    );
    expect(plan.notes.join('\n')).toContain('.husky/pre-commit exists');
    expect(read(target, '.husky/pre-push')).toContain(
      'repo-require-worktree pushes',
    );
  });

  it('rejects invalid specifications', () => {
    expect(() => resolveSpec({ repo: 'nope' })).toThrow(OnboardError);
    expect(() => resolveSpec({ repo: 'a/b', 'ci-checks': 'Build' })).toThrow(
      OnboardError,
    );
    expect(() => resolveSpec({ repo: 'a/b', hooks: 'magic' })).toThrow(
      OnboardError,
    );
  });
});
