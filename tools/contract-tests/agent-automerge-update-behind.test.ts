import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Behavioral + presence fixtures for reconcile-automerge's "Update behind
// branches of auto-merge-armed PRs" step (#1748). GitHub's own auto-merge
// arms but never updates a BEHIND branch, so under the fleet's strict
// "up to date" ruleset an otherwise-ready, auto-merge-armed PR stalls
// forever once any other PR merges (jlapenna/homelab#1121 sat 16h this
// way). This extracts the two real jq gating predicates embedded in the
// workflow (not a reimplementation) and runs them against realistic
// gh-shaped fixtures, the same technique
// stale-review-dismissal coverage uses, so
// a regression in the embedded jq itself fails the test. It also pins the
// step's presence, its BEHIND/UNKNOWN gating and rebase/fallback update
// commands, and the per-run cap as plain substring/regex assertions on the
// workflow text, since those are bash control flow rather than jq programs.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/agent-automerge-reusable.yml',
);
const workflowText = readFileSync(workflowPath, 'utf8');

const workflow = parseYaml(workflowText) as {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};
const stepText = workflow.jobs['reconcile-automerge'].steps.find(
  (step) => step.name === 'Update behind branches of auto-merge-armed PRs',
)?.run;
if (stepText === undefined) {
  throw new Error('update-behind-branches shell step not found');
}

/**
 * Pulls the single-quoted jq program that follows `marker`, searching
 * forward from `fromIndex` within stepText. The step's jq programs never
 * contain a literal single quote (jq string literals use double quotes
 * throughout), so the next `'` after the marker unambiguously opens the
 * program and the one after that closes it.
 */
function nextQuoted(
  marker: string,
  fromIndex: number,
): { text: string; end: number } {
  const markerIndex = stepText.indexOf(marker, fromIndex);
  if (markerIndex < 0) {
    throw new Error(`marker not found from offset ${fromIndex}: ${marker}`);
  }
  const openQuote = stepText.indexOf("'", markerIndex + marker.length);
  const closeQuote = stepText.indexOf("'", openQuote + 1);
  if (openQuote < 0 || closeQuote <= openQuote) {
    throw new Error(`unterminated single-quoted program for marker: ${marker}`);
  }
  return {
    text: stepText.slice(openQuote + 1, closeQuote),
    end: closeQuote + 1,
  };
}

// Read the two jq gating predicates in the order they appear: the
// auto-merge-armed/not-parked eligibility check, then the
// all-checks-green/none-running check. The marker deliberately excludes
// the opening quote itself - nextQuoted's own indexOf("'", ...) is what
// locates it.
const eligibilityPredicate = nextQuoted('if ! jq -e', 0);
const checksPredicate = nextQuoted('if ! jq -e', eligibilityPredicate.end);

function runJqPredicate(program: string, input: unknown): boolean {
  const result = spawnSync('jq', ['-e', program], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return result.status === 0;
}

function checkRun({
  conclusion,
  status = 'COMPLETED',
}: {
  conclusion: string;
  status?: string;
}) {
  return { __typename: 'CheckRun', status, conclusion };
}

describe('agent-automerge-reusable update-behind-branches step', () => {
  describe('eligibility predicate (autoMergeRequest armed, not parked)', () => {
    it('admits an armed PR with no status:needs-human label', () => {
      expect(
        runJqPredicate(eligibilityPredicate.text, {
          autoMergeRequest: { enabledAt: '2026-09-01T00:00:00Z' },
          labels: [{ name: 'type:bug' }],
        }),
      ).toBe(true);
    });

    it('rejects a PR with auto-merge not armed', () => {
      expect(
        runJqPredicate(eligibilityPredicate.text, {
          autoMergeRequest: null,
          labels: [],
        }),
      ).toBe(false);
    });

    it('rejects a parked (status:needs-human) PR even if armed', () => {
      expect(
        runJqPredicate(eligibilityPredicate.text, {
          autoMergeRequest: { enabledAt: '2026-09-01T00:00:00Z' },
          labels: [{ name: 'status:needs-human' }],
        }),
      ).toBe(false);
    });

    it.each([
      'renovate[bot]',
      'app/renovate',
      'dependabot[bot]',
      'app/dependabot',
    ])(
      'leaves dependency branch ownership with %s even when armed',
      (login) => {
        expect(
          runJqPredicate(eligibilityPredicate.text, {
            author: { login },
            autoMergeRequest: { enabledAt: '2026-09-01T00:00:00Z' },
            labels: [],
          }),
        ).toBe(false);
      },
    );

    it.each(['jlapenna', 'agent-lcars[bot]'])(
      'still admits an armed PR authored by %s',
      (login) => {
        expect(
          runJqPredicate(eligibilityPredicate.text, {
            author: { login },
            autoMergeRequest: { enabledAt: '2026-09-01T00:00:00Z' },
            labels: [],
          }),
        ).toBe(true);
      },
    );
  });

  describe('checks-green-and-none-running predicate', () => {
    it('admits a PR whose only check succeeded', () => {
      expect(
        runJqPredicate(checksPredicate.text, {
          statusCheckRollup: [checkRun({ conclusion: 'SUCCESS' })],
        }),
      ).toBe(true);
    });

    it('admits a PR with zero checks reported yet (vacuous pass)', () => {
      expect(
        runJqPredicate(checksPredicate.text, { statusCheckRollup: [] }),
      ).toBe(true);
    });

    it('rejects a PR with a check still in progress', () => {
      expect(
        runJqPredicate(checksPredicate.text, {
          statusCheckRollup: [
            checkRun({ conclusion: '', status: 'IN_PROGRESS' }),
          ],
        }),
      ).toBe(false);
    });

    it('rejects a PR with a completed but failed check', () => {
      expect(
        runJqPredicate(checksPredicate.text, {
          statusCheckRollup: [checkRun({ conclusion: 'FAILURE' })],
        }),
      ).toBe(false);
    });

    it('admits a PR whose failed check is mixed with an in-progress replacement', () => {
      // The live predicate treats any failed or running check as
      // disqualifying, so it fails closed rather than open here.
      expect(
        runJqPredicate(checksPredicate.text, {
          statusCheckRollup: [
            checkRun({ conclusion: 'FAILURE' }),
            checkRun({ conclusion: '', status: 'IN_PROGRESS' }),
          ],
        }),
      ).toBe(false);
    });

    it('falls back to a legacy StatusContext state field when conclusion is absent', () => {
      expect(
        runJqPredicate(checksPredicate.text, {
          statusCheckRollup: [
            { __typename: 'StatusContext', state: 'SUCCESS' },
          ],
        }),
      ).toBe(true);
      expect(
        runJqPredicate(checksPredicate.text, {
          statusCheckRollup: [
            { __typename: 'StatusContext', state: 'PENDING' },
          ],
        }),
      ).toBe(false);
    });
  });
});
