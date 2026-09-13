import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Behavioral + presence fixtures for reconcile-automerge's "Dismiss stale
// bot CHANGES_REQUESTED reviews on armed green agent PRs" step (#1953).
// GitHub's dismiss_stale_reviews never auto-removes a review authored by a
// GitHub App, so a fleet bot's CHANGES_REQUESTED keeps reviewDecision
// blocked across every later push and an armed auto-merge parks forever with
// green checks (measured on supersprinklesracing PR #5577). Same silent-
// stall family as #1748, hence the same testing technique: extract the real
// jq programs embedded in the workflow (not a reimplementation) and run them
// against realistic gh/REST-shaped fixtures, and pin the bash guards
// (admission gate, thread guard, cap, dismissal shape) as substring/regex
// assertions on the step text.

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
  '- name: Dismiss stale bot CHANGES_REQUESTED reviews on armed green agent PRs',
);
if (stepAnchor < 0) {
  throw new Error(
    'reconcile-automerge "Dismiss stale bot CHANGES_REQUESTED reviews" step not found',
  );
}
// The next step's comment header bounds the step body so extraction and
// assertions below cannot accidentally match the behind-branch sweep's
// similar predicates.
const stepEnd = workflowText.indexOf('\n      # #1748: the fleet', stepAnchor);
if (stepEnd < 0) {
  throw new Error('could not find the end of the stale-review-dismissal step');
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

// Read the jq programs in the order they appear: the
// armed-and-CHANGES_REQUESTED eligibility gate, then the
// all-checks-green/none-running gate (both `if ! jq -e`), then the stale
// bot-review selection program fed to the dismissal loop.
const eligibilityPredicate = nextQuoted('if ! jq -e', 0);
const checksPredicate = nextQuoted('if ! jq -e', eligibilityPredicate.end);
const selectionProgram = nextQuoted(
  '--argjson bots "$AGENT_BOT_LOGINS"',
  checksPredicate.end,
);

function runJqPredicate(program: string, input: unknown): boolean {
  const result = spawnSync('jq', ['-e', program], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return result.status === 0;
}

function runSelection(
  reviews: unknown,
  headDate: string,
  bots: string[],
): unknown[] {
  const result = spawnSync(
    'jq',
    [
      '-c',
      '--arg',
      'head_date',
      headDate,
      '--argjson',
      'bots',
      JSON.stringify(bots),
      selectionProgram.text,
    ],
    { input: JSON.stringify(reviews), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`selection jq failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const BOT_LOGINS = ['agent-lcars[bot]', 'claude[bot]'];
const HEAD_DATE = '2026-09-13T02:00:00Z';

describe('stale-review-dismissal eligibility gate', () => {
  it('fires only for an armed PR whose decision is CHANGES_REQUESTED', () => {
    expect(
      runJqPredicate(eligibilityPredicate.text, {
        autoMergeRequest: { enabledBy: { login: 'agent-lcars-bot' } },
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    ).toBe(true);
    expect(
      runJqPredicate(eligibilityPredicate.text, {
        autoMergeRequest: { enabledBy: { login: 'agent-lcars-bot' } },
        reviewDecision: 'APPROVED',
      }),
    ).toBe(false);
    expect(
      runJqPredicate(eligibilityPredicate.text, {
        autoMergeRequest: null,
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    ).toBe(false);
  });
});

describe('stale-review-dismissal green-checks gate', () => {
  it('passes only when every check is completed and green', () => {
    expect(
      runJqPredicate(checksPredicate.text, {
        statusCheckRollup: [
          { name: 'Verify', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'E2E Tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    ).toBe(true);
    expect(
      runJqPredicate(checksPredicate.text, {
        statusCheckRollup: [
          { name: 'Verify', status: 'COMPLETED', conclusion: 'SUCCESS' },
          {
            name: 'Full verification',
            status: 'IN_PROGRESS',
            conclusion: null,
          },
        ],
      }),
    ).toBe(false);
    expect(
      runJqPredicate(checksPredicate.text, {
        statusCheckRollup: [
          { name: 'Verify', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      }),
    ).toBe(false);
    expect(
      runJqPredicate(checksPredicate.text, {
        statusCheckRollup: [{ name: 'legacy-status', state: 'SUCCESS' }],
      }),
    ).toBe(true);
  });
});

describe('stale-review-dismissal review selection', () => {
  it('selects a bot CHANGES_REQUESTED review older than the head commit', () => {
    expect(
      runSelection(
        [
          {
            id: 5188727889,
            user: { login: 'agent-lcars[bot]' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-13T00:20:46Z',
          },
        ],
        HEAD_DATE,
        BOT_LOGINS,
      ),
    ).toEqual([
      {
        id: 5188727889,
        login: 'agent-lcars[bot]',
        submitted_at: '2026-09-13T00:20:46Z',
      },
    ]);
  });

  it('never selects a human-authored CHANGES_REQUESTED review', () => {
    expect(
      runSelection(
        [
          {
            id: 1,
            user: { login: 'jlapenna' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-13T00:00:00Z',
          },
        ],
        HEAD_DATE,
        BOT_LOGINS,
      ),
    ).toEqual([]);
  });

  it('never selects a bot review submitted at/after the current head commit', () => {
    expect(
      runSelection(
        [
          {
            id: 2,
            user: { login: 'claude[bot]' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-13T02:05:00Z',
          },
        ],
        HEAD_DATE,
        BOT_LOGINS,
      ),
    ).toEqual([]);
  });

  it('ignores COMMENTED and APPROVED reviews of a bot', () => {
    expect(
      runSelection(
        [
          {
            id: 3,
            user: { login: 'agent-lcars[bot]' },
            state: 'COMMENTED',
            submitted_at: '2026-09-13T00:00:00Z',
          },
          {
            id: 4,
            user: { login: 'agent-lcars[bot]' },
            state: 'APPROVED',
            submitted_at: '2026-09-13T02:30:00Z',
          },
        ],
        HEAD_DATE,
        BOT_LOGINS,
      ),
    ).toEqual([]);
  });

  it('keeps the live gate when a bot asked for changes on the current head', () => {
    // The real #5577 shape: a stale pre-fix CHANGES_REQUESTED from the bot,
    // mixed with an old COMMENTED from a connector bot and the coordinator
    // APPROVED that eventually landed. Only the stale CHANGES_REQUESTED is
    // selected; the comment and the approval stay untouched.
    expect(
      runSelection(
        [
          {
            id: 10,
            user: { login: 'chatgpt-codex-connector[bot]' },
            state: 'COMMENTED',
            submitted_at: '2026-09-13T00:19:42Z',
          },
          {
            id: 11,
            user: { login: 'agent-lcars[bot]' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-13T00:20:46Z',
          },
          {
            id: 12,
            user: { login: 'agent-lcars[bot]' },
            state: 'APPROVED',
            submitted_at: '2026-09-13T02:25:10Z',
          },
        ],
        HEAD_DATE,
        BOT_LOGINS,
      ),
    ).toEqual([
      {
        id: 11,
        login: 'agent-lcars[bot]',
        submitted_at: '2026-09-13T00:20:46Z',
      },
    ]);
  });

  it('selects stale reviews from several fleet bots in one pass', () => {
    expect(
      runSelection(
        [
          {
            id: 20,
            user: { login: 'agent-lcars[bot]' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-12T23:00:00Z',
          },
          {
            id: 21,
            user: { login: 'claude[bot]' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-13T01:59:59Z',
          },
        ],
        HEAD_DATE,
        BOT_LOGINS,
      ).map((r) => (r as { id: number }).id),
    ).toEqual([20, 21]);
  });
});

describe('stale-review-dismissal step guards (workflow text pins)', () => {
  it('requires the agent-authorship admission gate before acting', () => {
    expect(stepText).toMatch(/AGENT_BOT_LOGINS.*index\(\$login\) != null/s);
  });

  it('skips parked and draft PRs', () => {
    expect(stepText).toContain('status:needs-human');
    expect(stepText).toContain('select(.draft == false)');
  });

  it('requires every review thread resolved before dismissing', () => {
    expect(stepText).toContain('isResolved == false');
  });

  it('is bounded per run', () => {
    expect(stepText).toContain('MAX_DISMISSALS=5');
  });

  it('uses the dismissals endpoint with the message field that API requires', () => {
    // The endpoint 422s with "message wasn't supplied" if you send the
    // intuitive dismissal_message name instead (verified live on #5577).
    expect(stepText).toMatch(
      /gh api "repos\/\$REPO\/pulls\/\$PR\/reviews\/\$RID\/dismissals"[\s\S]*--method PUT/,
    );
    expect(stepText).toContain('--field message=');
    expect(stepText).not.toContain('dismissal_message');
  });

  it('compares ISO timestamps lexicographically with the right direction', () => {
    expect(selectionProgram.text).toContain('.submitted_at < $head_date');
  });

  it('tallies dismissal failures rather than swallowing them', () => {
    expect(stepText).toMatch(
      /Could not dismiss stale CHANGES_REQUESTED review/,
    );
    expect(stepText.trimEnd().endsWith('[ "$FAILED" -eq 0 ]')).toBe(true);
  });
});
