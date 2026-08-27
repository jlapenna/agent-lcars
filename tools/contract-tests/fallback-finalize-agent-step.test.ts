import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Behavioral fixtures for agent-fallback-finalize.yml's "Derive trusted
// completion evidence" step, following the extract-and-execute convention
// of agent-automerge-required-checks.test.ts: the real jq programs embedded
// in the workflow (not a reimplementation) run against gh-shaped job
// fixtures, so a regression in the embedded jq itself fails here.
//
// The regression this pins: the opencode lane is era-split into a
// 'Run OpenCode' step (dispatch-bootstrap era) and a 'Run OpenCode (CLI)'
// step (consumer era). Whichever era ran, the OTHER step still appears in
// the jobs API with conclusion 'skipped'. When the finalizer matched only
// 'Run OpenCode', every failed consumer-era run resolved its agent
// conclusion to 'skipped' and was misclassified as a startup-failure.
//
// Since #1340 A-R1 the worker job additionally lives in the single
// parameterized agent-lane.yml behind two levels of reusable-workflow
// nesting: its jobs-API name is "<caller job> / <shim job> / agent"
// (e.g. 'claude / claude / agent'), and EVERY pipeline's agent steps
// exist in that one job, with the inactive pipelines' steps reported as
// conclusion 'skipped'. The fixtures below cover both the historical
// per-lane job shapes (in-flight runs on the old lanes) and the unified
// nested shape.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/agent-fallback-finalize.yml',
);
const workflowText = fs.readFileSync(workflowPath, 'utf8');

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
const codexSteps = nextQuoted('codex.yml) agent_steps=');

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

  // ---- Unified-lane shape (#1340 A-R1): one nested job named
  // '<caller> / <shim> / agent' carrying every pipeline's agent steps,
  // the inactive pipelines' reported as 'skipped'.

  /** The unified job's step list: the active pipeline's agent step gets
   * `conclusion`, every other pipeline's agent step reports 'skipped'. */
  function unifiedJob(
    pipeline: 'claude' | 'codex' | 'opencode',
    conclusion: string,
    postGates: string,
  ) {
    const activeSteps: Record<string, string[]> = {
      claude: ['Run Claude Code'],
      codex: ['Run Codex'],
      // The bootstrap era's step is the one that runs in this repo; the
      // consumer-era CLI step stays skipped alongside the other lanes'.
      opencode: ['Run OpenCode'],
    };
    const allAgentSteps = [
      'Run Claude Code',
      'Run Codex',
      'Run OpenCode',
      'Run OpenCode (CLI)',
    ];
    return job(`${pipeline} / ${pipeline} / agent`, [
      step(
        'Checkout with the authorized App credential (bootstrap era)',
        'success',
      ),
      ...allAgentSteps.map((name) =>
        step(
          name,
          activeSteps[pipeline].includes(name) ? conclusion : 'skipped',
        ),
      ),
      step('Run post-agent gates', postGates),
    ]);
  }

  it('classifies a unified-lane claude success as success', () => {
    const workerJob = unifiedJob('claude', 'success', 'success');
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

  it('classifies a failed unified-lane codex run as an agent failure', () => {
    // The skipped sibling-pipeline steps must not shadow the failed codex
    // step the way the era-split opencode regression did.
    const workerJob = unifiedJob('codex', 'failure', 'failure');
    const selected = runJq(
      '-c',
      selectWorkerJob,
      codexSteps,
      pages(finalizeJob, workerJob),
    );
    expect(selected).not.toBe('');
    const conclusion = runJq(
      '-r',
      deriveConclusion,
      codexSteps,
      JSON.parse(selected),
    );
    expect(conclusion).toBe('failure');
  });

  it('classifies a failed unified-lane opencode run as an agent failure', () => {
    const workerJob = unifiedJob('opencode', 'failure', 'failure');
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

  it('keeps startup-failure when the unified lane never reached the agent step', () => {
    // e.g. "Assert pipeline lane configuration" or a checkout failed:
    // every pipeline's agent step is skipped, which IS a startup failure.
    const workerJob = unifiedJob('claude', 'skipped', 'failure');
    const selected = runJq(
      '-c',
      selectWorkerJob,
      claudeSteps,
      pages(finalizeJob, workerJob),
    );
    const conclusion = runJq(
      '-r',
      deriveConclusion,
      claudeSteps,
      JSON.parse(selected),
    );
    expect(conclusion).toBe('skipped');
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

// --- Success-branch outcome derivation: executes the REAL embedded
// "Derive trusted completion evidence" script end-to-end (not an isolated
// jq snippet) against a fake `gh`, following the same extract-and-execute
// convention as the jq fixtures above -- extended here to the whole
// script because the bug this pins is about the ORDER independent lookup
// blocks run in, not any single jq program.
//
// The regression (Codex review on #1564, jlapenna/agent-lcars PR #1564
// line 243): a run that opens a PR and only then discovers a blocker
// stamps the SAME attempt-claim marker on both the PR and its structured
// park comment. The PR lookup runs first and sets outcome_kind=
// 'pull-request'; the comment-lookup block used to be gated on
// `[ -z "$outcome_kind" ]`, so it never ran at all once a PR was found --
// the run's own explicit "I am blocked" was silently discarded and the
// broker reported success.

function extractRunScript(stepNameMarker: string): string {
  const stepIndex = workflowText.indexOf(stepNameMarker);
  if (stepIndex < 0) {
    throw new Error(`step not found: ${stepNameMarker}`);
  }
  const runLineMatch = /\n( *)run: \|\n/u.exec(workflowText.slice(stepIndex));
  if (runLineMatch === null || runLineMatch.index === undefined) {
    throw new Error(`run block not found after: ${stepNameMarker}`);
  }
  const runLineIndent = runLineMatch[1]!.length;
  const contentIndent = runLineIndent + 2;
  const bodyStart = stepIndex + runLineMatch.index + runLineMatch[0].length;
  const lines: string[] = [];
  for (const line of workflowText.slice(bodyStart).split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    const indent = /^ */u.exec(line)![0].length;
    if (indent <= runLineIndent) break;
    lines.push(line.slice(contentIndent));
  }
  return lines.join('\n');
}

const evidenceScript = extractRunScript(
  '- name: Derive trusted completion evidence',
);

// A bash FUNCTION, not an external binary on PATH: this sandbox's process
// spawning rewrites/prepends a child's PATH (verified directly -- an
// explicitly-set PATH with a fake `gh` shim first still resolved the
// REAL `gh` from elsewhere), so shadowing `gh` via PATH is not reliable
// here. A shell function named `gh`, defined in the SAME bash invocation
// ahead of the extracted script, takes priority over any PATH search for
// an unqualified command and is inherited by every `$(...)` command
// substitution the extracted script uses -- no PATH, tempdir, or chmod
// involved.
const fakeGhFunction = `
gh() {
  if [ "\${1:-}" != "api" ]; then
    echo "fake gh: unsupported invocation: $*" >&2
    return 64
  fi
  shift
  # The real script calls this with flags (--paginate --slurp) BEFORE the
  # path for some endpoints and no flags at all for others, so find the
  # one arg that actually looks like an API path rather than assuming a
  # fixed position.
  local path=""
  for arg in "$@"; do
    case "$arg" in
      repos/*) path="$arg" ;;
    esac
  done
  local key
  case "$path" in
    *"/pulls?state=all"*) key=pulls ;;
    *"/comments?"*) key=comments ;;
    *"/reviews?"*) key=reviews ;;
    *"/actions/runs/"*"/jobs"*) key=jobs ;;
    *"/issues/"*) key=issue ;;
    *)
      echo "fake gh: unrecognized api path: $path" >&2
      return 64
      ;;
  esac
  if [ -f "$FAKE_GH_DIR/$key.json" ]; then
    cat "$FAKE_GH_DIR/$key.json"
  else
    case "$key" in
      jobs) printf '[{"total_count":0,"jobs":[]}]\\n' ;;
      pulls|comments|reviews) printf '[[]]\\n' ;;
      issue) printf '{"pull_request":null}\\n' ;;
    esac
  fi
}
`;

interface EvidenceFixtures {
  pulls?: unknown;
  comments?: unknown;
  reviews?: unknown;
}

/** Runs the real embedded evidence-derivation script end to end (real
 *  bash, real jq, a fake `gh`) and returns the parsed GITHUB_OUTPUT
 *  contents as a plain key/value map. `pulls`/`comments`/`reviews`
 *  fixtures follow `gh api --paginate --slurp`'s own shape: an array of
 *  pages, each page the raw array that endpoint returns (so `[[]]` is
 *  one empty page, matching the script's `.[][]` double-iteration). */
function runEvidenceScript(
  fixtures: EvidenceFixtures,
  envOverrides: Record<string, string> = {},
): Record<string, string> {
  const fakeGhDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  for (const [key, value] of Object.entries(fixtures)) {
    if (value === undefined) continue;
    fs.writeFileSync(
      path.join(fakeGhDir, `${key}.json`),
      JSON.stringify(value),
    );
  }
  const outputPath = path.join(fakeGhDir, 'github-output');
  fs.writeFileSync(outputPath, '');

  const result = spawnSync(
    'bash',
    ['-c', `${fakeGhFunction}\n${evidenceScript}`],
    {
      encoding: 'utf8',
      env: {
        // A real interactive PATH, not narrowed to a fake-only bin dir --
        // the real `gh` is never reached (the function above shadows it
        // unconditionally), but `bash`/`jq`/coreutils still need to
        // resolve normally.
        PATH: process.env['PATH'] ?? '',
        FAKE_GH_DIR: fakeGhDir,
        GH_TOKEN: 'test-token',
        REPO: 'example/consumer',
        ISSUE: '70',
        WORK: '',
        GENERATION: '1',
        INTENT_ID: 'example/consumer#70/r1',
        WORKER_WORKFLOW: 'claude.yml',
        WORKER_RESULT: 'success',
        GITHUB_RUN_ID: '999',
        GITHUB_OUTPUT: outputPath,
        ...envOverrides,
      },
    },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  const output: Record<string, string> = {};
  for (const line of fs.readFileSync(outputPath, 'utf8').split('\n')) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    output[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return output;
}

const claimMarker = '<!-- attempt-claim:g1:example/consumer#70/r1 -->';

describe('fallback-finalize success-branch outcome derivation', () => {
  it('classifies a marked PR alone as pull-request', () => {
    const output = runEvidenceScript({
      pulls: [[{ number: 42, title: '', body: `Fixes #70\n\n${claimMarker}` }]],
    });
    expect(output['outcome-kind']).toBe('pull-request');
    expect(output['outcome-reference']).toBe('42');
  });

  it('classifies a marked park comment alone as park', () => {
    const output = runEvidenceScript({
      comments: [
        [
          {
            id: 1,
            body: `PARK: blocked.\n<!-- agent-result:v1:park -->\n${claimMarker}`,
          },
        ],
      ],
    });
    expect(output['outcome-kind']).toBe('park');
  });

  it(
    'lets an explicit park override an already-found PR outcome -- a run ' +
      'that opens a PR and then discovers a blocker is still parked, not ' +
      'a silent success (Codex review on #1564)',
    () => {
      const output = runEvidenceScript({
        pulls: [
          [{ number: 42, title: '', body: `Fixes #70\n\n${claimMarker}` }],
        ],
        comments: [
          [
            {
              id: 1,
              body: `PARK: blocked.\n<!-- agent-result:v1:park -->\n${claimMarker}`,
            },
          ],
        ],
      });
      expect(output['outcome-kind']).toBe('park');
    },
  );

  it('still lets a marked PR win when there is no park comment (unchanged behavior)', () => {
    const output = runEvidenceScript({
      pulls: [[{ number: 42, title: '', body: `Fixes #70\n\n${claimMarker}` }]],
      comments: [[{ id: 1, body: `Just a status update.\n${claimMarker}` }]],
    });
    expect(output['outcome-kind']).toBe('pull-request');
  });
});
