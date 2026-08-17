import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Behavioral fixtures for agent-fallback-finalize.yml's "Derive trusted
// completion evidence" step, following the extract-and-execute convention
// of agent-automerge-required-checks.test.ts: the real jq programs embedded
// in the workflow (not a reimplementation) run against gh-shaped job
// fixtures, so a regression in the embedded jq itself fails here.
//
// The regression this pins: agent-lane-opencode.yml is era-split into a
// 'Run OpenCode' step (dispatch-bootstrap era) and a 'Run OpenCode (CLI)'
// step (consumer era). Whichever era ran, the OTHER step still appears in
// the jobs API with conclusion 'skipped'. When the finalizer matched only
// 'Run OpenCode', every failed consumer-era run resolved its agent
// conclusion to 'skipped' and was misclassified as a startup-failure.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/agent-fallback-finalize.yml',
);
const workflowText = readFileSync(workflowPath, 'utf8');

/**
 * Pulls the single-quoted program/value that follows `marker`. The
 * workflow's jq programs and agent_steps JSON arrays never contain a
 * literal single quote (jq and JSON string literals use double quotes
 * throughout), so the next `'` after the marker unambiguously opens the
 * text and the one after that closes it.
 */
function nextQuoted(marker: string): string {
  const markerIndex = workflowText.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`marker not found: ${marker}`);
  }
  const openQuote = workflowText.indexOf("'", markerIndex + marker.length);
  const closeQuote = workflowText.indexOf("'", openQuote + 1);
  if (openQuote < 0 || closeQuote <= openQuote) {
    throw new Error(`unterminated single-quoted text for marker: ${marker}`);
  }
  return workflowText.slice(openQuote + 1, closeQuote);
}

// The real per-lane candidate step names, read from the workflow's own
// case statement rather than hand-copied.
const opencodeSteps = nextQuoted('opencode.yml) agent_steps=');
const claudeSteps = nextQuoted('claude.yml) agent_steps=');

// The two jq programs the evidence step runs: worker-job selection over
// the slurped paginated jobs API, and the agent-step conclusion.
const selectWorkerJob = nextQuoted('worker_job="$(jq -c --argjson steps');
const deriveConclusion = nextQuoted(
  'agent_conclusion="$(jq -r --argjson steps',
);

function runJq(
  flag: '-c' | '-r',
  program: string,
  stepsJson: string,
  input: unknown,
): string {
  const result = spawnSync(
    'jq',
    [flag, '--argjson', 'steps', stepsJson, program],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

interface StepFixture {
  name: string;
  status: string;
  conclusion: string | null;
}

function job(name: string, steps: StepFixture[]) {
  return { name, steps };
}

function step(name: string, conclusion: string | null): StepFixture {
  return {
    name,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
  };
}

// `gh api --paginate --slurp .../jobs` shape: an array of page objects,
// each carrying a `jobs` array.
function pages(...jobs: ReturnType<typeof job>[]) {
  return [{ total_count: jobs.length, jobs }];
}

const finalizeJob = job('finalize', [
  step('Derive trusted completion evidence', 'success'),
]);

describe('fallback-finalize agent-step derivation', () => {
  it('reads both era-split opencode step names from the workflow', () => {
    expect(JSON.parse(opencodeSteps)).toEqual([
      'Run OpenCode',
      'Run OpenCode (CLI)',
    ]);
  });

  it('classifies a failed consumer-era opencode run as an agent failure', () => {
    // The consumer-era shape: 'Run OpenCode' exists but is SKIPPED (the
    // jobs API lists skipped steps), 'Run OpenCode (CLI)' actually ran
    // and failed. Before the two-name fix this derived 'skipped', i.e.
    // startup-failure.
    const workerJob = job('opencode', [
      step('Checkout', 'success'),
      step('Run OpenCode', 'skipped'),
      step('Run OpenCode (CLI)', 'failure'),
      step('Run post-agent gates', 'failure'),
    ]);
    const selected = runJq(
      '-c',
      selectWorkerJob,
      opencodeSteps,
      pages(finalizeJob, workerJob),
    );
    expect(selected).not.toBe('');
    const conclusion = runJq(
      '-r',
      deriveConclusion,
      opencodeSteps,
      JSON.parse(selected),
    );
    expect(conclusion).toBe('failure');
  });

  it('classifies a failed bootstrap-era opencode run as an agent failure', () => {
    const workerJob = job('opencode', [
      step('Run OpenCode', 'failure'),
      step('Run OpenCode (CLI)', 'skipped'),
    ]);
    const selected = runJq(
      '-c',
      selectWorkerJob,
      opencodeSteps,
      pages(workerJob),
    );
    const conclusion = runJq(
      '-r',
      deriveConclusion,
      opencodeSteps,
      JSON.parse(selected),
    );
    expect(conclusion).toBe('failure');
  });

  it('still reports skipped when BOTH era steps were skipped', () => {
    // Neither era's agent step ran: that IS a startup failure, and the
    // derivation must keep saying so.
    const workerJob = job('opencode', [
      step('Checkout', 'failure'),
      step('Run OpenCode', 'skipped'),
      step('Run OpenCode (CLI)', 'skipped'),
    ]);
    const selected = runJq(
      '-c',
      selectWorkerJob,
      opencodeSteps,
      pages(workerJob),
    );
    const conclusion = runJq(
      '-r',
      deriveConclusion,
      opencodeSteps,
      JSON.parse(selected),
    );
    expect(conclusion).toBe('skipped');
  });

  it('keeps the single-step claude lane derivation intact', () => {
    const workerJob = job('claude', [
      step('Checkout', 'success'),
      step('Run Claude Code', 'success'),
    ]);
    const selected = runJq(
      '-c',
      selectWorkerJob,
      claudeSteps,
      pages(finalizeJob, workerJob),
    );
    expect(selected).not.toBe('');
    const conclusion = runJq(
      '-r',
      deriveConclusion,
      claudeSteps,
      JSON.parse(selected),
    );
    expect(conclusion).toBe('success');
  });

  it('finds no worker job when no candidate step exists anywhere', () => {
    const selected = runJq(
      '-c',
      selectWorkerJob,
      opencodeSteps,
      pages(finalizeJob),
    );
    expect(selected).toBe('');
  });

  it("maps ''/skipped conclusions to startup-failure in the workflow", () => {
    // The bash classification the jq conclusions feed into: keep the
    // empty/skipped branch pinned so the fixtures above imply the
    // outcome-kind they claim to.
    expect(workflowText).toContain(
      "''|skipped) outcome_kind='startup-failure' ;;",
    );
  });
});
