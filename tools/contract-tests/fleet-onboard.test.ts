import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  applyAdmit,
  applyScaffold,
  BASELINE_CHECKS,
  ensureRepoToolsHookIds,
  GENERATED_WORKFLOW_NAMES,
  GUARDRAIL_COMMAND,
  latestReleaseTag,
  main,
  MANAGED_MARKER,
  membershipGaps,
  mergeAgentsSection,
  mergeGitignore,
  mergeGuardrailHooks,
  mergePreCommitConfig,
  mergeRepoToolsDependency,
  OnboardError,
  parseCli,
  planAdmit,
  planScaffold,
  readMembership,
  renderAgentsSection,
  renderPlan,
  resolveRepoToolsRev,
  resolveSpec,
  workflowRunNames,
} from '../fleet-onboard.mjs';
import { assertVariables, auditRepository } from '../verify-onboarding.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const PROJECTIONS = [
  'config/github-labels.json',
  'apps/console/apphosting.yaml',
  '.github/workflows/label-contract-audit.yml',
  'config/github-variables.json',
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

function scaffold(
  target: string,
  options: Record<string, string> = {},
  apply: { check?: boolean; force?: boolean } = {},
) {
  const plan = planScaffold(target, spec(options), { check: apply.check });
  return { plan, results: applyScaffold(target, plan, apply) };
}

function run(argv: string[], root = repoRoot) {
  const log: string[] = [];
  const code = main(argv, { root, log: (line: string) => log.push(line) });
  return { code, log };
}

// sync-padd's live gitleaks caller shape: no managed marker, but it posts the
// `gitleaks` check from a workflow named `gitleaks`.
const COMPATIBLE_GITLEAKS = `name: gitleaks
on: [pull_request]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - run: true
`;

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
        variables: ['a/b', 'c/d'],
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

  it('admits a repository that the onboarding audit recognizes, once', async () => {
    const root = copyProjections();
    const edits = planAdmit(
      root,
      spec({ alias: 'proj' }),
      'jlapenna/sync-padd',
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
    const facts = await auditRepository({
      repo: 'example/project',
      token: 'fixture-token',
      fleetLogin: 'fleet',
      labels: JSON.parse(read(root, 'config/github-labels.json')),
      profiles: JSON.parse(read(root, 'config/github-variables.json')).profiles,
      checkVariables: assertVariables,
      api: async (route: string) => {
        if (route.includes('/actions/variables?'))
          return { variables: [{ name: 'AGENT_FLEET_LOGIN', value: 'fleet' }] };
        throw new Error('Unrelated fact unavailable in this metadata fixture');
      },
    });
    expect(
      facts.find((fact: { fact: string }) => fact.fact === 'variables'),
    ).toMatchObject({
      status: 'pass',
      detail: 'required fleet-member variables present',
    });
    const log: string[] = [];
    expect(main(['check'], { root, log: (line) => log.push(line) })).toBe(0);
  });

  it('refuses a repository present in only one console list', () => {
    const root = copyProjections();
    const file = PROJECTIONS[1];
    write(
      root,
      file,
      // Append to the control-plane list regardless of which member is last.
      read(root, file).replace(
        /(AGENT_LCARS_CONTROL_PLANE_REPOSITORIES\n\s+value: '[^']*)'/,
        "$1,example/project'",
      ),
    );
    expect(() => planAdmit(root, spec(), 'jlapenna/sync-padd')).toThrow(
      OnboardError,
    );
  });

  it('keeps the manifest formatting and refuses an unexpected layout', () => {
    const root = copyProjections();
    const before = read(root, PROJECTIONS[0]);
    applyAdmit(root, planAdmit(root, spec(), 'jlapenna/sync-padd'), {});
    const after = read(root, PROJECTIONS[0]);
    // Prettier keeps short arrays inline; the copy must not reflow them.
    expect(after).toContain('"bug": ["type:bug"]');
    expect(
      after.startsWith(before.slice(0, before.indexOf('"repositories"'))),
    ).toBe(true);
    expect(after.endsWith('\n')).toBe(true);
    expect(() =>
      planAdmit(root, spec({ repo: 'other/repo' }), 'nobody/here'),
    ).toThrow(/nobody\/here has no entry/);

    const minified = scratch('fleet-onboard-root');
    for (const file of PROJECTIONS) write(minified, file, read(root, file));
    write(
      minified,
      PROJECTIONS[0],
      JSON.stringify(JSON.parse(read(root, PROJECTIONS[0]))),
    );
    expect(() =>
      planAdmit(minified, spec({ repo: 'other/repo' }), 'jlapenna/sync-padd'),
    ).toThrow(/label manifest layout/);
  });

  it('refuses an alias already used by another repository', () => {
    const root = copyProjections();
    // supersprinklesracing/www already owns the alias `www`.
    expect(() =>
      planAdmit(root, spec({ repo: 'jlapenna/www' }), 'jlapenna/sync-padd'),
    ).toThrow(/alias www is already used by supersprinklesracing\/www/);
    const edits = planAdmit(
      root,
      spec({ repo: 'jlapenna/www', alias: 'jl-www' }),
      'jlapenna/sync-padd',
    );
    applyAdmit(root, edits, {});
    expect(readMembership(root).watchedEntries).toContainEqual({
      owner: 'jlapenna',
      name: 'www',
      alias: 'jl-www',
    });
  });

  it('completes a repository present in only some projections', () => {
    const root = copyProjections();
    const all = planAdmit(root, spec(), 'jlapenna/sync-padd');
    const labelsOnly = all.filter((edit) => edit.file === PROJECTIONS[0]);
    applyAdmit(root, labelsOnly, {});
    const rest = planAdmit(root, spec(), 'jlapenna/sync-padd');
    applyAdmit(root, rest, {});
    expect(membershipGaps(readMembership(root))).toEqual({});
    expect(planAdmit(root, spec(), 'jlapenna/sync-padd')).toEqual([]);
  });

  it('treats apphosting values literally when appending', () => {
    const root = copyProjections();
    const file = PROJECTIONS[1];
    // `$&` and `$1` are String.replace replacement patterns; an existing
    // alias containing them must survive untouched.
    write(
      root,
      file,
      read(root, file).replace(
        '"alias":"sync-padd"}',
        () => '"alias":"sync$&pa$1dd"}',
      ),
    );
    applyAdmit(root, planAdmit(root, spec(), 'jlapenna/sync-padd'), {});
    const after = read(root, file);
    expect(after.split('"alias":"sync$&pa$1dd"')).toHaveLength(2);
    expect(readMembership(root).watched).toContain('example/project');
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
    expect(log).toContain('missing\tconfig/github-variables.json');
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
    expect(gitleaks.jobs.gitleaks['runs-on']).toContain('ubuntu-slim');

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
      'ubuntu-slim',
    ]);
    expect(
      JSON.parse(automerge.jobs.automerge.with['required-checks']),
    ).toEqual([...BASELINE_CHECKS]);
    expect(
      parseYaml(read(target, '.github/workflows/gitleaks.yml')).jobs.gitleaks[
        'runs-on'
      ],
    ).toBe('ubuntu-slim');
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
    const prePush = read(target, '.husky/pre-push');
    expect(prePush).toContain(
      `printf '%s\\n' "$refs" | repo-require-worktree pushes`,
    );
    expect(prePush).toContain(MANAGED_MARKER);
    expect(prePush).not.toContain('command -v');
    expect(
      JSON.parse(read(target, 'package.json')).devDependencies[
        '@jlapenna/repo-tools'
      ],
    ).toBe(`github:jlapenna/repo-tools#${REV}`);
    expect(plan.notes.join('\n')).toContain('run `npm install`');
  });

  it('refreshes managed Husky hooks so they fail closed', () => {
    const target = scratch('fleet-onboard-target');
    write(target, 'package.json', '{"name":"x"}\n');
    write(target, 'pnpm-lock.yaml', '');
    write(
      target,
      '.husky/pre-commit',
      `#!/bin/sh\n# ${MANAGED_MARKER}\nif command -v repo-require-worktree >/dev/null 2>&1; then repo-require-worktree commits; fi\n`,
    );
    const { plan, results } = scaffold(target);
    expect(results.find((r) => r.file === '.husky/pre-commit')?.action).toBe(
      'update',
    );
    const preCommit = read(target, '.husky/pre-commit');
    expect(preCommit).toMatch(/\nrepo-require-worktree commits\n$/);
    expect(preCommit).not.toContain('command -v');
    expect(plan.notes.join('\n')).toContain('run `pnpm install`');
  });

  it('keeps an existing repo-tools dependency and reports non-tag pins', () => {
    const tagged =
      '{\n    "devDependencies": {\n        "@jlapenna/repo-tools": "github:jlapenna/repo-tools#v1.2.3"\n    }\n}\n';
    expect(mergeRepoToolsDependency(tagged, 'v9.9.9')).toEqual({
      text: tagged,
      note: null,
    });
    const branch = tagged.replace('#v1.2.3', '#main');
    const merged = mergeRepoToolsDependency(branch, 'v9.9.9');
    expect(merged.text).toBe(branch);
    expect(merged.note).toContain('"github:jlapenna/repo-tools#main"');

    const added = mergeRepoToolsDependency(
      '{\n    "devDependencies": {\n        "zod": "1",\n        "@a/b": "1"\n    }\n}\n',
      'v1.5.3',
    ).text;
    expect(added).toContain('\n        "@jlapenna/repo-tools"');
    expect(Object.keys(JSON.parse(added).devDependencies)).toEqual([
      'zod',
      '@a/b',
      '@jlapenna/repo-tools',
    ]);
    const sorted = mergeRepoToolsDependency(
      '{"devDependencies":{"@a/b":"1","zod":"1"}}',
      'v1.5.3',
    ).text;
    expect(Object.keys(JSON.parse(sorted).devDependencies)).toEqual([
      '@a/b',
      '@jlapenna/repo-tools',
      'zod',
    ]);

    const target = scratch('fleet-onboard-target');
    write(target, 'package.json', branch);
    const { plan, results } = scaffold(target);
    expect(results.find((r) => r.file === 'package.json')?.action).toBe(
      'unchanged',
    );
    expect(plan.notes.join('\n')).toContain('not a release tag');
  });

  it.each(['main', 'a'.repeat(40)])(
    'reports an existing pre-commit revision %s without rewriting it',
    (rev) => {
      const target = scratch('fleet-onboard-target');
      const config = `repos:\n  - repo: https://github.com/jlapenna/repo-tools\n    rev: ${rev}\n    hooks:\n      - id: repo-require-worktree\n      - id: repo-require-worktree-push\n`;
      write(target, '.pre-commit-config.yaml', config);
      const { plan } = scaffold(target);
      expect(read(target, '.pre-commit-config.yaml')).toBe(config);
      expect(plan.notes.join('\n')).toContain('not a release tag');
      expect(plan.notes.join('\n')).toContain(rev);
    },
  );

  it('resolves the highest repo-tools release tag', () => {
    const output = [
      'aaa\trefs/tags/v1.9.0',
      'bbb\trefs/tags/v1.10.0',
      'ccc\trefs/tags/v1.10.0^{}',
      'ddd\trefs/tags/v2.0.0-rc.1',
      'eee\trefs/tags/v1.10.0.1',
      'fff\trefs/tags/vnext',
      '',
    ].join('\n');
    expect(latestReleaseTag(output)).toBe('v1.10.0');
    expect(latestReleaseTag('')).toBeNull();

    const calls: string[][] = [];
    const exec = (_cmd: string, args: string[]) => {
      calls.push(args);
      return output;
    };
    expect(resolveRepoToolsRev({ repoToolsRev: null }, exec)).toBe('v1.10.0');
    expect(calls[0]).toEqual([
      'ls-remote',
      '--tags',
      'https://github.com/jlapenna/repo-tools.git',
      'v*',
    ]);
    expect(resolveRepoToolsRev({ repoToolsRev: 'v0.1.0' }, exec)).toBe(
      'v0.1.0',
    );
    expect(calls).toHaveLength(1);
    expect(() => resolveRepoToolsRev({ repoToolsRev: null }, () => '')).toThrow(
      /no vX\.Y\.Z release tag/,
    );
    expect(() =>
      resolveRepoToolsRev({ repoToolsRev: null }, () => {
        throw new Error('offline');
      }),
    ).toThrow(/release tags \(offline\)/);
  });

  it('rejects invalid specifications', () => {
    expect(() => resolveSpec({ repo: 'nope' })).toThrow(OnboardError);
    expect(() => resolveSpec({ repo: 'a/b', 'ci-checks': 'Build' })).toThrow(
      OnboardError,
    );
    expect(() => resolveSpec({ repo: 'a/b', hooks: 'magic' })).toThrow(
      OnboardError,
    );
    expect(() =>
      resolveSpec({ repo: 'a/b', 'ci-workflow-name': 'CI' }),
    ).toThrow(/requires --ci-workflow/);
    expect(() =>
      resolveSpec({
        repo: 'a/b',
        'ci-workflow': 'a.yml,b.yml',
        'ci-workflow-name': 'A',
      }),
    ).toThrow(/one name per workflow/);
    expect(() =>
      resolveSpec({ repo: 'a/b', 'ci-workflow': '../ci.yml' }),
    ).toThrow(/file name under .github\/workflows/);
    expect(() =>
      resolveSpec({ repo: 'a/b', 'runner-label': 'bad label' }),
    ).toThrow(/--runner-label/);
  });

  it('replaces a legacy guardrail hook instead of adding a second', () => {
    const target = scratch('fleet-onboard-target');
    const legacy =
      'repo_root=$(git rev-parse --show-toplevel); node "$repo_root/tools/codex-issue-guardrail.cjs"; exit 0';
    write(
      target,
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash|Edit',
              hooks: [
                { type: 'command', command: 'echo sibling' },
                { type: 'command', command: legacy, timeout: 5 },
              ],
            },
            { matcher: 'Bash', hooks: [{ type: 'command', command: legacy }] },
            { matcher: 'Edit', hooks: [] },
          ],
        },
      }),
    );
    scaffold(target);
    const post = JSON.parse(read(target, '.claude/settings.json')).hooks
      .PostToolUse;
    const commands = post.flatMap((entry: { hooks: { command: string }[] }) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(commands).toEqual(['echo sibling', GUARDRAIL_COMMAND]);
    expect(post[0].matcher).toBe('Bash|Edit');
    expect(post[0].hooks[1].timeout).toBe(10);
    // The group that only held a legacy copy is gone; an unrelated empty
    // group is not ours to remove.
    expect(post.map((entry: { matcher: string }) => entry.matcher)).toEqual([
      'Bash|Edit',
      'Edit',
    ]);
    const again = scaffold(target);
    expect(
      again.results.find((r) => r.file === '.claude/settings.json')?.action,
    ).toBe('unchanged');
    expect(() =>
      mergeGuardrailHooks(
        JSON.stringify({ hooks: { PostToolUse: {} } }),
        'Bash',
      ),
    ).toThrow(OnboardError);
    expect(() => mergeGuardrailHooks('[]', 'Bash')).toThrow(OnboardError);
  });

  it('keeps AGENTS.md line endings and rejects duplicate blocks', () => {
    const crlf = '# Project\r\n\r\nLocal rules.\r\n';
    const merged = mergeAgentsSection(crlf, renderAgentsSection());
    expect(merged.startsWith(crlf)).toBe(true);
    expect(/[^\r]\n/.test(merged)).toBe(false);
    expect(mergeAgentsSection(merged, renderAgentsSection())).toBe(merged);
    const lf = mergeAgentsSection('# Project\n', renderAgentsSection());
    expect(lf).not.toContain('\r');
    const block = renderAgentsSection();
    expect(() => mergeAgentsSection(`${block}\n${block}\n`, block)).toThrow(
      /2 fleet-onboard blocks/,
    );
    expect(() =>
      mergeAgentsSection(
        '<!-- fleet-onboard:end -->\n<!-- fleet-onboard:begin -->\n',
        block,
      ),
    ).toThrow(/must come before/);
  });

  it('merges pre-commit configs whatever their list style', () => {
    const empty = mergePreCommitConfig('repos: []\n', REV);
    expect(parseYaml(empty).repos.map((r: { repo: string }) => r.repo)).toEqual(
      ['https://github.com/jlapenna/repo-tools'],
    );
    const flush = mergePreCommitConfig(
      'repos:\n- repo: https://x\n  rev: v1\n  hooks:\n  - id: a\n',
      REV,
    );
    expect(parseYaml(flush).repos.map((r: { repo: string }) => r.repo)).toEqual(
      ['https://github.com/jlapenna/repo-tools', 'https://x'],
    );
    expect(flush).toContain('\n- repo: https://github.com/jlapenna/repo-tools');
    expect(flush).not.toContain('\n\n');
    expect(() => mergePreCommitConfig('fail_fast: true\n', REV)).toThrow(
      /no top-level repos/,
    );
    expect(() => mergePreCommitConfig('repos: {a: 1}\n', REV)).toThrow(
      /not a block list/,
    );
  });

  it('seeds pre-commit without content fixers and ignores the provider cache', () => {
    const target = scratch('fleet-onboard-target');
    const { plan } = scaffold(target);
    const hooks = parseYaml(
      read(target, '.pre-commit-config.yaml'),
    ).repos.flatMap((r: { hooks: { id: string }[] }) =>
      r.hooks.map((h) => h.id),
    );
    expect(hooks).not.toContain('trailing-whitespace');
    expect(hooks).not.toContain('end-of-file-fixer');
    expect(hooks).toContain('check-yaml');
    expect(plan.notes.join('\n')).toContain('content-rewriting');
    expect(read(target, '.gitignore')).toBe(
      'infra/github-ruleset/.terraform/\n',
    );
    expect(mergeGitignore('node_modules/\n.terraform/\n')).toBe(
      'node_modules/\n.terraform/\n',
    );
    expect(mergeGitignore('dist\r\n')).toBe(
      'dist\r\ninfra/github-ruleset/.terraform/\r\n',
    );
    expect(renderPlan(plan.spec, plan)).toContain('content-rewriting hooks');
  });

  it('escapes check names safely and rejects the ones it cannot', () => {
    const target = scratch('fleet-onboard-target');
    scaffold(target, { 'ci-workflow': 'ci.yml', 'ci-checks': "Bob's build" });
    const automerge = parseYaml(
      read(target, '.github/workflows/agent-automerge.yml'),
    );
    expect(
      JSON.parse(automerge.jobs.automerge.with['required-checks']),
    ).toContain("Bob's build");
    expect(read(target, 'infra/github-ruleset/main.tf')).toContain(
      'context = "Bob\'s build"',
    );
    for (const bad of ['say "hi"', 'back\\slash', 'tab\there', 'x ${y}'])
      expect(() =>
        resolveSpec({ repo: 'a/b', 'ci-workflow': 'ci.yml', 'ci-checks': bad }),
      ).toThrow(/may not contain/);
  });

  it('never resolves the repo-tools revision in check mode', () => {
    const target = scratch('fleet-onboard-target');
    const explode = () => {
      throw new Error('network');
    };
    const plan = planScaffold(target, resolveSpec({ repo: 'a/b' }), {
      resolveRev: explode,
      check: true,
    });
    const results = applyScaffold(target, plan, { check: true });
    expect(
      results.find((r) => r.file === '.pre-commit-config.yaml')?.drift,
    ).toBe(true);
    expect(() =>
      planScaffold(target, resolveSpec({ repo: 'a/b' }), {
        resolveRev: explode,
      }),
    ).toThrow('network');
    let calls = 0;
    scaffold(target);
    planScaffold(target, resolveSpec({ repo: 'a/b' }), {
      resolveRev: () => {
        calls++;
        return REV;
      },
    });
    expect(calls).toBe(0);
  });

  it('reports conflicts when a locally owned workflow cannot satisfy the ruleset', () => {
    const target = scratch('fleet-onboard-target');
    write(
      target,
      '.github/workflows/gitleaks.yml',
      'name: Secret Scanning\non: [pull_request]\njobs:\n  scan:\n    name: Gitleaks Scan\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',
    );
    write(
      target,
      '.github/workflows/validate.yml',
      COMPATIBLE_GITLEAKS.replace(/gitleaks/g, 'validate').replace(
        'validate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true',
        'validate:\n    uses: jlapenna/agent-lcars/.github/workflows/repo-validation.yml@main',
      ),
    );
    write(target, 'infra/github-ruleset/main.tf', 'resource "x" "y" {}\n');
    const args = [
      'scaffold',
      '--repo',
      'example/project',
      '--target',
      target,
      '--repo-tools-rev',
      REV,
    ];
    const check = run([...args, '--check']);
    expect(check.code).toBe(1);
    const conflicts = check.log.filter((line) => line.startsWith('conflict\t'));
    expect(conflicts.map((line) => line.split('\t')[1]).sort()).toEqual([
      '.github/workflows/gitleaks.yml',
      'infra/github-ruleset/main.tf',
    ]);
    expect(conflicts.join('\n')).toContain('"Secret Scanning"');
    expect(conflicts.join('\n')).toContain(
      'no job posts the required check "gitleaks"',
    );
    expect(read(target, '.github/workflows/gitleaks.yml')).toContain(
      'Secret Scanning',
    );

    const written = run(args);
    expect(written.code).toBe(1);
    expect(written.log.join('\n')).toContain('CONFLICTS');
    expect(written.log.join('\n')).toContain(
      '`.github/workflows/validate.yml`',
    );
    expect(read(target, '.github/workflows/gitleaks.yml')).toContain(
      'Secret Scanning',
    );

    const forced = run([...args, '--force']);
    expect(forced.code).toBe(0);
    expect(forced.log.some((line) => line.startsWith('conflict\t'))).toBe(
      false,
    );
    expect(read(target, '.github/workflows/gitleaks.yml')).toContain(
      MANAGED_MARKER,
    );

    // A locally owned file that already emits the right check is not a
    // conflict, only locally owned.
    const compatible = scratch('fleet-onboard-target');
    write(compatible, '.github/workflows/gitleaks.yml', COMPATIBLE_GITLEAKS);
    const ok = run([
      'scaffold',
      '--repo',
      'example/project',
      '--target',
      compatible,
      '--repo-tools-rev',
      REV,
      '--check',
    ]);
    expect(ok.log).toContain('locally-owned\t.github/workflows/gitleaks.yml');
    expect(ok.log.some((line) => line.startsWith('conflict\t'))).toBe(false);
  });

  it('subscribes agent-automerge to every CI workflow by its real name', () => {
    const target = scratch('fleet-onboard-target');
    write(
      target,
      '.github/workflows/ci.yml',
      'name: Build\non: [pull_request]\njobs:\n  test:\n    name: Unit tests\n    runs-on: ubuntu-latest\n    steps: []\n',
    );
    write(
      target,
      '.github/workflows/pre-commit.yml',
      'name: pre-commit\non: [pull_request]\njobs:\n  pre-commit:\n    runs-on: ubuntu-latest\n    steps: []\n  tf:\n    name: repository-owned Terraform\n    runs-on: ubuntu-latest\n    steps: []\n',
    );
    const { plan } = scaffold(target, {
      'ci-workflow': 'ci.yml,pre-commit.yml',
      'ci-checks': 'Unit tests,pre-commit,Missing',
    });
    const automerge = parseYaml(
      read(target, '.github/workflows/agent-automerge.yml'),
    );
    expect(automerge.on.workflow_run.workflows).toEqual([
      'Build',
      'pre-commit',
      ...GENERATED_WORKFLOW_NAMES,
    ]);
    expect(plan.notes.join('\n')).toContain(
      '"Missing" is not a job id or name',
    );
    expect(plan.notes.join('\n')).not.toContain('"Unit tests" is not');
    expect(plan.notes.join('\n')).toContain(
      'already posts the check "repository-owned Terraform"',
    );
    expect(renderPlan(plan.spec, plan)).toContain(
      'repository CI checks included',
    );
    expect(renderPlan(spec(), null)).toContain(
      "add the repository's own CI checks",
    );

    expect(() =>
      scaffold(target, { 'ci-workflow': 'ci.yml', 'ci-workflow-name': 'CI' }),
    ).toThrow(/is named "Build", not "CI"/);
    expect(() =>
      scaffold(target, { 'ci-workflow': 'ci.yml,other.yml' }),
    ).toThrow(/other.yml does not exist; pass --ci-workflow-name/);
    expect(() =>
      workflowRunNames(
        resolveSpec({ repo: 'a/b', 'ci-workflow': 'a.yml,b.yml' }),
      ),
    ).toThrow(/needs --ci-workflow-name/);
    expect(
      parseCli(['scaffold', '--ci-workflow', 'a.yml', '--ci-workflow', 'b.yml'])
        .options['ci-workflow'],
    ).toEqual(['a.yml', 'b.yml']);
  });

  it('generates workflow names and check contexts that match the reusable contract', () => {
    const target = scratch('fleet-onboard-target');
    scaffold(target);
    const validate = parseYaml(read(target, '.github/workflows/validate.yml'));
    const reusable = parseYaml(
      read(repoRoot, '.github/workflows/repo-validation.yml'),
    );
    expect(validate.jobs.validate.uses).toContain('repo-validation.yml');
    const gitleaks = parseYaml(read(target, '.github/workflows/gitleaks.yml'));
    const ruleset = parseYaml(read(target, '.github/workflows/ruleset.yml'));
    const emitted = [
      Object.keys(gitleaks.jobs)[0],
      `validate / ${reusable.jobs.validate.name}`,
      ruleset.jobs.terraform.name,
    ];
    expect(emitted).toEqual([...BASELINE_CHECKS]);
    const automerge = parseYaml(
      read(target, '.github/workflows/agent-automerge.yml'),
    );
    const required = JSON.parse(
      automerge.jobs.automerge.with['required-checks'],
    );
    const tf = read(target, 'infra/github-ruleset/main.tf');
    const contexts = [...tf.matchAll(/context = "([^"]+)"/g)].map((m) => m[1]);
    expect(contexts).toEqual(required);
  });

  it('reports guarded Husky hooks as unchanged and trusts an existing prepare script', () => {
    const target = scratch('fleet-onboard-target');
    write(
      target,
      'package.json',
      '{"name":"x","scripts":{"prepare":"husky"}}\n',
    );
    write(
      target,
      '.husky/pre-commit',
      '#!/bin/sh\nrepo-require-worktree commits\n',
    );
    const { plan, results } = scaffold(target);
    expect(results.find((r) => r.file === '.husky/pre-commit')?.action).toBe(
      'unchanged',
    );
    expect(results.find((r) => r.file === '.husky/pre-push')?.action).toBe(
      'create',
    );
    expect(plan.notes.join('\n')).not.toContain('prepare');
    expect(read(target, '.husky/pre-commit')).toBe(
      '#!/bin/sh\nrepo-require-worktree commits\n',
    );
  });

  it('runs as a CLI through a symlink', { timeout: 60_000 }, () => {
    const dir = scratch('fleet-onboard-link');
    const link = path.join(dir, 'fo.mjs');
    symlinkSync(path.join(repoRoot, 'tools/fleet-onboard.mjs'), link);
    const out = execFileSync(
      process.execPath,
      [link, 'plan', '--repo', 'a/b', '--runner-label', 'b-default'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('# Remaining onboarding steps for a/b');
    expect(out).toContain('`b-default` ARC lane');
    let status: number | undefined;
    try {
      execFileSync(process.execPath, [link, 'plan', '--repo', 'nope'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status?: number }).status;
    }
    expect(status).toBe(2);
  });
});

describe('review follow-ups', () => {
  it('threads a non-main default branch through every generated trigger', () => {
    const target = scratch('fleet-onboard-target');
    scaffold(target, { 'default-branch': 'trunk' });
    for (const file of [
      '.github/workflows/validate.yml',
      '.github/workflows/gitleaks.yml',
      '.github/workflows/ruleset.yml',
      '.github/workflows/agent-automerge.yml',
    ]) {
      const text = read(target, file);
      expect(text).toContain('branches: [trunk]');
      expect(text).not.toContain('refs/heads/main');
      expect(text).not.toMatch(/branches: \[main\]/);
    }
    expect(() =>
      resolveSpec({ repo: 'a/b', 'default-branch': 'bad branch' }),
    ).toThrow(OnboardError);
  });

  it('completes a repo-tools entry that lacks a guard hook', () => {
    const partial = [
      'repos:',
      '  - repo: https://github.com/jlapenna/repo-tools',
      '    rev: abc',
      '    hooks:',
      '      - id: repo-require-worktree',
      '  - repo: https://github.com/pre-commit/pre-commit-hooks',
      '    rev: v5.0.0',
      '    hooks:',
      '      - id: check-yaml',
      '',
    ].join('\n');
    const merged = ensureRepoToolsHookIds(partial);
    const entry = parseYaml(merged).repos[0];
    expect(entry.hooks.map((hook: { id: string }) => hook.id)).toEqual([
      'repo-require-worktree',
      'repo-require-worktree-push',
    ]);
    expect(parseYaml(merged).repos[1].hooks).toEqual([{ id: 'check-yaml' }]);
    expect(ensureRepoToolsHookIds(merged)).toBe(merged);

    const other = partial.replace(
      '      - id: repo-require-worktree\n',
      '      - id: repo-check-schedules\n',
    );
    const ids = parseYaml(ensureRepoToolsHookIds(other)).repos[0].hooks.map(
      (hook: { id: string }) => hook.id,
    );
    expect(ids).toEqual([
      'repo-check-schedules',
      'repo-require-worktree',
      'repo-require-worktree-push',
    ]);

    const empty = partial.replace(
      '    hooks:\n      - id: repo-require-worktree\n',
      '    hooks: []\n',
    );
    expect(
      parseYaml(ensureRepoToolsHookIds(empty)).repos[0].hooks,
    ).toHaveLength(2);
  });
});
