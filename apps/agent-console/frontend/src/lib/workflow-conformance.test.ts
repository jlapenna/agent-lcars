import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { issueNumberFromDisplayTitle } from './agent-activity';
import { pipelineForLabels } from './primary-action';

// The console re-implements, in TypeScript, contracts whose other half
// lives in .github/workflows/*.yml: run-name prefixes, mention triggers,
// dispatch labels, author allowlists. Nothing type-checks across that
// boundary, so each pair can only drift silently — this suite pins the
// load-bearing strings on both sides so a workflow edit that breaks the
// console (or vice versa) fails a unit test instead of a production join
// (#3023; the drift catalog is orchestration.md §10.4).

// Walk up from wherever the runner starts (repo root via ./tools/vitest,
// app dir via the Nx executor) to the workspace root's workflow directory.
function findWorkflowsDir(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.github', 'workflows');
    if (existsSync(join(candidate, 'claude.yml'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`.github/workflows not found above ${process.cwd()}`);
    }
    dir = parent;
  }
}

const WORKFLOWS_DIR = findWorkflowsDir();

function workflow(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
}

describe('run-name join (console ↔ claude.yml/opencode.yml)', () => {
  it('claude.yml run-name starts with the #N: prefix the console parses', () => {
    expect(workflow('claude.yml')).toMatch(/^run-name: ["']#\$\{\{/m);
    expect(issueNumberFromDisplayTitle('#123: fix the thing')).toBe(123);
  });

  it('opencode.yml run-name starts with the opencode #N: prefix the console parses', () => {
    expect(workflow('opencode.yml')).toMatch(
      /^run-name: ["']opencode #\$\{\{/m,
    );
    expect(issueNumberFromDisplayTitle('opencode #123: fix the thing')).toBe(
      123,
    );
  });

  it('pr-heal.yml in-flight dedupe matches BOTH run-name prefixes', () => {
    const prHeal = workflow('pr-heal.yml');
    // The literal grep -E pattern shipped in the dedupe step (#3023).
    expect(prHeal).toContain('^(opencode )?#$n:');
    // And it scans both pipelines' run lists, not just claude.yml's.
    expect(prHeal).toContain('claude.yml opencode.yml');
    // The pattern itself accepts both live formats.
    const pattern = (n: number) => new RegExp(`^(opencode )?#${n}:`);
    expect('#77: title').toMatch(pattern(77));
    expect('opencode #77: title').toMatch(pattern(77));
  });
});

describe('dispatch labels and mention triggers', () => {
  it('claude.yml dispatches on the claude label and @claude mentions', () => {
    const claude = workflow('claude.yml');
    expect(claude).toContain("github.event.label.name == 'claude'");
    expect(claude).toContain("contains(github.event.comment.body, '@claude')");
  });

  it('opencode.yml dispatches on the opencode label and /opencode|/oc mentions', () => {
    const opencode = workflow('opencode.yml');
    expect(opencode).toContain("github.event.label.name == 'opencode'");
    expect(opencode).toContain(
      "contains(github.event.comment.body, '/opencode')",
    );
    expect(opencode).toContain("contains(github.event.comment.body, '/oc')");
  });

  it('opencode.yml stands down on dual-labeled issues, matching pipelineForLabels precedence', () => {
    const opencode = workflow('opencode.yml');
    // Both event paths carry the claude-wins exclusion (#3023).
    const exclusions = opencode.match(
      /!contains\(github\.event\.issue\.labels\.\*\.name, 'claude'\)/g,
    );
    expect(exclusions?.length).toBeGreaterThanOrEqual(2);
    // The console applies the same precedence: claude wins on dual-label.
    expect(pipelineForLabels(['claude', 'opencode'])).toBe('claude');
    expect(pipelineForLabels(['opencode'])).toBe('opencode');
    expect(pipelineForLabels(['claude'])).toBe('claude');
  });
});

describe('agent-PR author allowlists agree across the menders', () => {
  // claude-automerge.yml (arms auto-merge) and pr-heal.yml (heals failures)
  // must agree on what counts as an agent PR, or a PR could be
  // auto-merge-armed but never healed — or vice versa.
  it.each(['claude-automerge.yml', 'pr-heal.yml'])(
    '%s allowlists both agent identities',
    (file) => {
      const text = workflow(file);
      expect(text).toContain('claude[bot]');
      expect(text).toContain('github-actions[bot]');
    },
  );
});

describe('human-needed park signal (label, not assignees — #2802/#3023)', () => {
  it.each(['claude.yml', 'pr-heal.yml'])('%s keys on the label', (file) => {
    expect(workflow(file)).toContain('human-needed');
  });
});
