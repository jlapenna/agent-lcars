import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Behavioral + presence fixtures for reconcile-automerge's "Update behind
// branches of auto-merge-armed PRs" step (#1748). GitHub's own auto-merge
// arms but never updates a BEHIND branch, so under the fleet's strict
// "up to date" ruleset an otherwise-ready, auto-merge-armed PR stalls
// forever once any other PR merges (jlapenna/homelab#1121 sat 16h this
// way). This extracts the two real jq gating predicates embedded in the
// workflow (not a reimplementation) and runs them against realistic
// gh-shaped fixtures, the same technique
// agent-automerge-required-checks.test.ts uses for restore-main-checks, so
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

const stepAnchor = workflowText.indexOf(
  '- name: Update behind branches of auto-merge-armed PRs',
);
if (stepAnchor < 0) {
  throw new Error(
    'reconcile-automerge "Update behind branches of auto-merge-armed PRs" step not found',
  );
}
// The next step header (restore-main-checks's job key) bounds the step body
// so extraction/assertions below cannot accidentally match later content.
const stepEnd = workflowText.indexOf('\n  restore-main-checks:', stepAnchor);
if (stepEnd < 0) {
  throw new Error('could not find the end of the update-behind-branches step');
}
const stepText = workflowText.slice(stepAnchor, stepEnd);

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
// locates it - matching agent-automerge-required-checks.test.ts's
// convention.
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

    it('is not limited to agent bot-logins (no author field is consulted)', () => {
      // The predicate only ever reads .autoMergeRequest and .labels - no
      // author/login field exists in its input at all, which is what makes
      // "any author" true: there is nothing here that could filter on one.
      expect(eligibilityPredicate.text).not.toMatch(/login|author|bot-logins/);
    });
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
      // Not a claim about correctness of superseded-run handling (that
      // logic lives in restore-main-checks) - just documents that this
      // predicate treats "any non-running, non-SUCCESS entry" as
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

  describe('presence: BEHIND/UNKNOWN gating, rebase update with fallback, and the per-run cap', () => {
    it('only proceeds past the mergeStateStatus check for BEHIND', () => {
      expect(stepText).toMatch(
        /if \[ "\$STATUS" != BEHIND \]; then\s*\n\s*continue/,
      );
    });

    it('re-views once when mergeStateStatus is UNKNOWN before deciding', () => {
      expect(stepText).toMatch(/if \[ "\$STATUS" = UNKNOWN \]; then/);
      // The re-view must be a fresh gh pr view call, not a reuse of the
      // stale $VIEW captured before this check.
      const unknownBlock = stepText.slice(
        stepText.indexOf('if [ "$STATUS" = UNKNOWN ]; then'),
        stepText.indexOf('if [ "$STATUS" != BEHIND ]; then'),
      );
      expect(unknownBlock).toMatch(
        /gh pr view "\$PR" --repo "\$REPO" \\\s*\n\s*--json mergeStateStatus/,
      );
    });

    it('checks unresolved review threads via GraphQL reviewThreads before updating', () => {
      expect(stepText).toMatch(/gh api graphql --paginate/);
      expect(stepText).toMatch(/reviewThreads\(first:50, after:\$endCursor\)/);
      expect(stepText).toMatch(/select\(\.isResolved == false\)/);
      // The unresolved-thread check must run, and gate the update, before
      // the rebase/merge update-branch call further down the step.
      const threadsIndex = stepText.indexOf('reviewThreads(first:50');
      const updateIndex = stepText.indexOf('gh pr update-branch "$PR"');
      expect(threadsIndex).toBeGreaterThan(0);
      expect(threadsIndex).toBeLessThan(updateIndex);
    });

    it('runs the rebase update-branch form first, falling back to the default merge update if refused', () => {
      const rebaseIndex = stepText.indexOf(
        'if gh pr update-branch "$PR" --repo "$REPO" --rebase',
      );
      const fallbackIndex = stepText.indexOf(
        'elif gh pr update-branch "$PR" --repo "$REPO" >/dev/null',
      );
      expect(rebaseIndex).toBeGreaterThan(0);
      expect(fallbackIndex).toBeGreaterThan(rebaseIndex);
    });

    it('logs the PR number and new head after a successful update', () => {
      expect(stepText).toMatch(
        /NEW_HEAD=\$\(gh pr view "\$PR" --repo "\$REPO" --json headRefOid --jq '\.headRefOid'\)/,
      );
      expect(stepText).toMatch(
        /echo "Updated behind branch for PR #\$PR via \$METHOD; new head \$NEW_HEAD\."/,
      );
    });

    it('caps updates at 5 per run and stops the loop once the cap is reached', () => {
      expect(stepText).toMatch(/MAX_UPDATES=5/);
      expect(stepText).toMatch(
        /if \[ "\$UPDATED" -ge "\$MAX_UPDATES" \]; then\s*\n\s*echo "Reached the per-run cap[^"]*"\s*\n\s*break/,
      );
    });

    it('skips draft PRs before any other gating (matching the arm step above)', () => {
      expect(stepText).toMatch(/select\(\.draft == false\)/);
    });

    it('fails the job step if any single-PR update attempt failed', () => {
      expect(stepText).toMatch(/\[ "\$FAILED" -eq 0 \]\s*$/);
    });
  });
});
