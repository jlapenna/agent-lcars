import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Behavioral fixtures for the restore-main-checks job's required-check
// evaluation, ported from sprinkles' claude-automerge-required-checks.test.cjs
// when the logic moved into the published agent-automerge-reusable.yml
// (#1312 U4) - the canonical implementation and its regression fixtures
// travel together. GitHub's statusCheckRollup retains every historical
// check run under a context name, including ones superseded by a later run
// on the same exact PR head (sprinkles#4165). This test extracts the real
// jq programs embedded in the workflow (not a reimplementation) and
// executes them against realistic gh-shaped fixtures, so a regression in
// the embedded jq itself - not just a change in surrounding bash - fails
// the test.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/agent-automerge-reusable.yml',
);
const workflowText = readFileSync(workflowPath, 'utf8');

/**
 * Pulls the single-quoted jq program that follows `marker`, searching
 * forward from `fromIndex`. The workflow's jq programs never contain a
 * literal single quote (jq string literals use double quotes throughout),
 * so the next `'` after the marker unambiguously opens the program and the
 * one after that closes it.
 */
function nextQuoted(
  marker: string,
  fromIndex: number,
): { text: string; end: number } {
  const markerIndex = workflowText.indexOf(marker, fromIndex);
  if (markerIndex < 0) {
    throw new Error(`marker not found from offset ${fromIndex}: ${marker}`);
  }
  const openQuote = workflowText.indexOf("'", markerIndex + marker.length);
  const closeQuote = workflowText.indexOf("'", openQuote + 1);
  if (openQuote < 0 || closeQuote <= openQuote) {
    throw new Error(`unterminated single-quoted program for marker: ${marker}`);
  }
  return {
    text: workflowText.slice(openQuote + 1, closeQuote),
    end: closeQuote + 1,
  };
}

const checksAnchor = workflowText.indexOf(
  'CHECKS=$(jq -c --argjson req "$REQUIRED_CHECKS"',
);
if (checksAnchor < 0) {
  throw new Error('restore-main-checks CHECKS assignment not found');
}

// Read the three jq programs in the order they appear in the file: select
// the latest run per required check name, then the two `jq -e` predicates
// that decide green/failed from that selection.
const selectLatest = nextQuoted('--argjson req', checksAnchor);
const greenPredicate = nextQuoted('jq -e --argjson req', selectLatest.end);
const failedPredicate = nextQuoted('jq -e', greenPredicate.end);

interface CheckRunFixture {
  __typename: 'CheckRun';
  name: string;
  conclusion: string;
  status: string;
  startedAt: string;
  completedAt: string;
  workflowName: string;
  detailsUrl: string;
}

interface SelectedCheck {
  name: string;
  conclusion: string;
}

function runJq(
  program: string,
  input: unknown,
  extraArgs: string[] = [],
): { status: number | null; stdout: string } {
  const result = spawnSync('jq', [...extraArgs, program], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (!extraArgs.includes('-e')) {
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  return { status: result.status, stdout: result.stdout };
}

const REQUIRED = ['Verify', 'E2E Tests'];

/**
 * Faithfully reproduces the bash loop's single-iteration decision: select
 * the latest run per required name, then evaluate green/failed exactly as
 * `restore-main-checks` does.
 */
function classify(
  statusCheckRollup: CheckRunFixture[],
  required: string[] = REQUIRED,
): { checks: SelectedCheck[]; green: boolean; failed: boolean } {
  const requiredArgs = ['--argjson', 'req', JSON.stringify(required)];
  const selectResult = runJq(
    selectLatest.text,
    { statusCheckRollup },
    requiredArgs,
  );
  const checks = JSON.parse(selectResult.stdout) as SelectedCheck[];
  const green =
    runJq(greenPredicate.text, checks, [...requiredArgs, '-e']).status === 0;
  const failed = runJq(failedPredicate.text, checks, ['-e']).status === 0;
  return { checks, green, failed };
}

function checkRun({
  name,
  conclusion,
  status = 'COMPLETED',
  startedAt,
  completedAt = startedAt,
  runId,
}: {
  name: string;
  conclusion: string;
  status?: string;
  startedAt: string;
  completedAt?: string;
  runId: number;
}): CheckRunFixture {
  return {
    __typename: 'CheckRun',
    name,
    conclusion,
    status,
    startedAt,
    completedAt,
    workflowName: name === 'Verify' ? 'CI' : 'E2E',
    detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  };
}

describe('agent-automerge-reusable required-check evaluation', () => {
  it('does not block on an older cancelled run while the replacement is still running (cancelled -> running)', () => {
    const { green, failed } = classify([
      checkRun({
        name: 'Verify',
        conclusion: 'CANCELLED',
        startedAt: '2026-08-09T19:31:12Z',
        completedAt: '2026-08-09T19:31:23Z',
        runId: 1,
      }),
      checkRun({
        name: 'Verify',
        conclusion: '',
        status: 'IN_PROGRESS',
        startedAt: '2026-08-09T19:31:33Z',
        completedAt: '0001-01-01T00:00:00Z',
        runId: 2,
      }),
      checkRun({
        name: 'E2E Tests',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T19:31:25Z',
        completedAt: '2026-08-09T19:31:29Z',
        runId: 3,
      }),
    ]);

    // Must not merge while the replacement is still in flight, and the
    // superseded cancelled run must not surface as a failure.
    expect(green).toBe(false);
    expect(failed).toBe(false);
  });

  it('does not block on an older cancelled run once the replacement succeeds (cancelled -> running -> success)', () => {
    const { green, failed, checks } = classify([
      checkRun({
        name: 'Verify',
        conclusion: 'CANCELLED',
        startedAt: '2026-08-09T19:31:12Z',
        completedAt: '2026-08-09T19:31:23Z',
        runId: 1,
      }),
      checkRun({
        name: 'Verify',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T19:31:33Z',
        completedAt: '2026-08-09T20:04:20Z',
        runId: 2,
      }),
      checkRun({
        name: 'E2E Tests',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T19:31:25Z',
        completedAt: '2026-08-09T19:31:29Z',
        runId: 3,
      }),
    ]);

    expect(checks.find((check) => check.name === 'Verify')).toEqual({
      name: 'Verify',
      conclusion: 'SUCCESS',
    });
    // The healthy replacement must be recognized as authoritative.
    expect(green).toBe(true);
    expect(failed).toBe(false);
  });

  it('surfaces a newer failure even though an older run of the same name succeeded (success -> failure)', () => {
    const { green, failed, checks } = classify([
      checkRun({
        name: 'Verify',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T15:12:46Z',
        completedAt: '2026-08-09T15:12:55Z',
        runId: 1,
      }),
      checkRun({
        name: 'Verify',
        conclusion: 'FAILURE',
        startedAt: '2026-08-09T15:39:55Z',
        completedAt: '2026-08-09T15:40:03Z',
        runId: 2,
      }),
      checkRun({
        name: 'E2E Tests',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T15:15:51Z',
        completedAt: '2026-08-09T15:15:56Z',
        runId: 3,
      }),
    ]);

    expect(checks.find((check) => check.name === 'Verify')).toEqual({
      name: 'Verify',
      conclusion: 'FAILURE',
    });
    expect(green).toBe(false);
    // A genuine regression on the current head must not be hidden by an
    // earlier success.
    expect(failed).toBe(true);
  });

  it('collapses duplicate same-name entries to one authoritative run instead of double-counting', () => {
    const duplicate = checkRun({
      name: 'Verify',
      conclusion: 'SUCCESS',
      startedAt: '2026-08-09T15:12:46Z',
      completedAt: '2026-08-09T15:12:55Z',
      runId: 1000,
    });
    const { green, failed, checks } = classify([
      duplicate,
      { ...duplicate },
      checkRun({
        name: 'E2E Tests',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T15:20:00Z',
        completedAt: '2026-08-09T15:20:05Z',
        runId: 2000,
      }),
    ]);

    expect(checks).toHaveLength(2);
    expect(green).toBe(true);
    expect(failed).toBe(false);
  });

  it('resolves mixed Verify/E2E completion order by timestamp, not array position', () => {
    // Verify's newer, successful run is listed BEFORE its older, cancelled
    // run - and E2E Tests finishes its own replacement well after both
    // Verify entries - so a naive "last element wins" or "first element
    // wins" reading of the array would get this wrong in either direction.
    const { green, failed, checks } = classify([
      checkRun({
        name: 'Verify',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T19:31:33Z',
        completedAt: '2026-08-09T19:31:40Z',
        runId: 2,
      }),
      checkRun({
        name: 'Verify',
        conclusion: 'CANCELLED',
        startedAt: '2026-08-09T19:31:12Z',
        completedAt: '2026-08-09T19:31:23Z',
        runId: 1,
      }),
      checkRun({
        name: 'E2E Tests',
        conclusion: 'CANCELLED',
        startedAt: '2026-08-09T19:20:00Z',
        completedAt: '2026-08-09T19:20:10Z',
        runId: 3,
      }),
      checkRun({
        name: 'E2E Tests',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T19:42:39Z',
        completedAt: '2026-08-09T19:42:43Z',
        runId: 4,
      }),
    ]);

    expect([...checks].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'E2E Tests', conclusion: 'SUCCESS' },
      { name: 'Verify', conclusion: 'SUCCESS' },
    ]);
    expect(green).toBe(true);
    expect(failed).toBe(false);
  });

  it('does not falsely report green or failed for a required check with no runs yet', () => {
    const { green, failed, checks } = classify([
      checkRun({
        name: 'Verify',
        conclusion: 'SUCCESS',
        startedAt: '2026-08-09T19:31:12Z',
        completedAt: '2026-08-09T19:31:23Z',
        runId: 1,
      }),
    ]);

    expect(checks).toEqual([{ name: 'Verify', conclusion: 'SUCCESS' }]);
    // E2E Tests has not reported yet; a missing check is not a failure.
    expect(green).toBe(false);
    expect(failed).toBe(false);
  });

  it('evaluates only the caller-declared required checks (the input parameterizes the gate)', () => {
    // A single-required-check caller (agent-lcars: ["Verify"]) must ignore
    // other checks entirely - even a failed non-required check cannot
    // block or fail the gate.
    const { green, failed, checks } = classify(
      [
        checkRun({
          name: 'Verify',
          conclusion: 'SUCCESS',
          startedAt: '2026-08-09T19:31:12Z',
          completedAt: '2026-08-09T19:31:23Z',
          runId: 1,
        }),
        checkRun({
          name: 'E2E Tests',
          conclusion: 'FAILURE',
          startedAt: '2026-08-09T19:31:25Z',
          completedAt: '2026-08-09T19:31:29Z',
          runId: 2,
        }),
      ],
      ['Verify'],
    );

    expect(checks).toEqual([{ name: 'Verify', conclusion: 'SUCCESS' }]);
    expect(green).toBe(true);
    expect(failed).toBe(false);
  });
});
