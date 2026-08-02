import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Imported, not re-derived: this is the exact function the console uses to
// join a live workflow run to its action-item card (see its own doc comment
// in agent-activity.ts). Importing it - rather than copying/re-deriving the
// regex here - means an edit to the console's parsing logic is exercised by
// this test automatically instead of silently drifting from it.
import { issueNumberFromDisplayTitle } from '../../apps/console/src/lib/agent-activity';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * Values for the `${{ ... }}` expressions each workflow's `run-name`
 * actually references, standing in for what GitHub Actions would
 * substitute at render time. Every one of these workflows' worker jobs only
 * ever runs via `workflow_dispatch` (see each file's job-level `if:` -
 * gated on `github.event_name == 'workflow_dispatch'`), dispatched by the
 * serialized dispatch broker (#327, `.github/actions/dispatch-broker`):
 * `issue` is the field the console joins on; `broker_generation` and
 * `broker_intent_id` are the broker's own reconciliation markers, appended
 * to the title after the join key and irrelevant to parsing it.
 */
const EXPRESSION_VALUES: Record<string, string> = {
  'inputs.issue': '123',
  'inputs.broker_generation': '1',
  'inputs.broker_intent_id': 'intent-test-abc123',
};

const EXPRESSION_RE = /\$\{\{\s*([^}]+?)\s*\}\}/g;

/** Evaluates the small subset of GitHub Actions expression syntax these
 * `run-name` templates use: a bare dotted context path, or an `a || b`
 * fallback chain of them. Throws on anything else so a run-name edit that
 * introduces an expression this harness doesn't understand fails loudly
 * instead of silently rendering "undefined". */
function evaluateExpression(expr: string): string {
  const operands = expr.split('||').map((operand) => operand.trim());
  for (const operand of operands) {
    if (!(operand in EXPRESSION_VALUES)) {
      throw new Error(
        `Unmapped run-name expression operand "${operand}" (full expression: "${expr}"). ` +
          'Add a plausible value to EXPRESSION_VALUES in this test.',
      );
    }
    const value = EXPRESSION_VALUES[operand];
    if (value) return value;
  }
  // GitHub Actions' `||` falls through to the last operand's (falsy) value
  // when every operand is falsy - mirrored here rather than throwing, since
  // that is itself a real rendering outcome worth asserting against.
  return EXPRESSION_VALUES[operands[operands.length - 1]];
}

/** Renders a `run-name:` template the way GitHub Actions would for a real
 * dispatch, substituting each `${{ ... }}` with EXPRESSION_VALUES. */
function renderRunName(template: string): string {
  return template.replace(EXPRESSION_RE, (_, expr: string) =>
    evaluateExpression(expr),
  );
}

function loadRunName(workflowRelativePath: string): string {
  const contents = readFileSync(
    path.join(repoRoot, workflowRelativePath),
    'utf8',
  );
  const doc = parseYaml(contents) as { 'run-name'?: unknown };
  const runName = doc['run-name'];
  if (typeof runName !== 'string') {
    throw new Error(
      `${workflowRelativePath} has no string \`run-name:\` field - the console can no longer join runs from it to an issue.`,
    );
  }
  return runName;
}

// One entry per workflow that the console's Agent Activity panel joins
// live runs from by parsing displayTitle - see agent-activity.ts's
// `resolveWorkflowFile` / AgentPipeline and watched-repo.ts's
// agentIntegration() wiring for the (repo, pipeline) -> workflow file map
// this mirrors.
const WORKFLOWS = [
  '.github/workflows/claude.yml',
  '.github/workflows/codex.yml',
  '.github/workflows/opencode.yml',
];

describe('run-name <-> console join contract', () => {
  it.each(WORKFLOWS)(
    '%s renders a run-name the console can parse back to the dispatched issue number',
    (workflowRelativePath) => {
      const template = loadRunName(workflowRelativePath);
      const rendered = renderRunName(template);

      expect(issueNumberFromDisplayTitle(rendered)).toBe(
        Number(EXPRESSION_VALUES['inputs.issue']),
      );
    },
  );

  it('extracts different issue numbers for different dispatches (not a coincidental match)', () => {
    const originalValue = EXPRESSION_VALUES['inputs.issue'];
    try {
      for (const issue of ['1', '42', '9999']) {
        EXPRESSION_VALUES['inputs.issue'] = issue;
        for (const workflowRelativePath of WORKFLOWS) {
          const rendered = renderRunName(loadRunName(workflowRelativePath));
          expect(issueNumberFromDisplayTitle(rendered)).toBe(Number(issue));
        }
      }
    } finally {
      EXPRESSION_VALUES['inputs.issue'] = originalValue;
    }
  });
});
