import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  DISPATCH_PIPELINES,
  formatAttemptId,
  formatClaimMarker,
  PIPELINE_CONTRACTS,
} from '../../libs/dispatch-contracts/src';

/**
 * The lane renders the fleet-canonical dispatch prompt and silent-stall
 * wording itself (#1340 A-R2), so 21 callers no longer hand-maintain
 * near-identical prose. That rendering is a shell step inside
 * agent-lane.yml, and the two facts it must get right - the exact
 * attempt-claim marker the deliverable gate later greps for, and each
 * pipeline's own redispatch vocabulary - are both derivable from
 * libs/dispatch-contracts.
 *
 * This test extracts that step's real `run:` script out of the workflow and
 * executes it, rather than re-describing what it is supposed to emit: a
 * marker whose format drifts from `formatClaimMarker` would strand every
 * consumer run's deliverable as unknown-success, and nothing else in CI runs
 * this script.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const RESOLVE_STEP_NAME = 'Resolve the canonical dispatch prompt';

function laneResolveScript(): string {
  const doc = parseYaml(
    readFileSync(
      path.join(repoRoot, '.github/workflows/agent-lane.yml'),
      'utf8',
    ),
  ) as { jobs: { agent: { steps: { name?: string; run?: string }[] } } };
  const step = doc.jobs.agent.steps.find((s) => s.name === RESOLVE_STEP_NAME);
  if (!step?.run) {
    throw new Error(
      `agent-lane.yml has no "${RESOLVE_STEP_NAME}" step with a run: script - ` +
        'the lane can no longer render the canonical prompt, and every caller ' +
        'that stopped passing one now dispatches an empty prompt.',
    );
  }
  return step.run;
}

interface RenderOptions {
  pipeline: (typeof DISPATCH_PIPELINES)[number];
  generation?: string;
  intentId?: string;
  protocolNote?: string;
  promptOverride?: string;
  noDeliverableOverride?: string;
}

/** Runs the lane step exactly as Actions would: same script, same env, and
 * a real $GITHUB_ENV file whose multi-line entries are parsed back out. */
function renderLaneDefaults({
  pipeline,
  generation = '7',
  intentId = 'intent-contract-test',
  protocolNote = '',
  promptOverride = '',
  noDeliverableOverride = '',
}: RenderOptions): Record<string, string> {
  const contract = PIPELINE_CONTRACTS[pipeline];
  const dir = mkdtempSync(path.join(tmpdir(), 'lane-prompt-'));
  const scriptPath = path.join(dir, 'resolve.sh');
  const envPath = path.join(dir, 'github_env');
  writeFileSync(scriptPath, laneResolveScript());
  writeFileSync(envPath, '');

  execFileSync('bash', [scriptPath], {
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_ENV: envPath,
      PROTOCOL_NOTE: protocolNote,
      PROMPT_OVERRIDE: promptOverride,
      NO_DELIVERABLE_OVERRIDE: noDeliverableOverride,
      ATTEMPT_ID: `g${generation}:${intentId}`,
      HAS_ATTEMPT_ID: intentId === '' ? 'false' : 'true',
      // Job-level lane env, pinned to this same registry by
      // worker-workflow-contract.test.ts.
      AGENT_LABEL: contract.label,
      REDISPATCH_COMMAND: contract.redispatchCommand,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const rendered: Record<string, string> = {};
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const heredoc = lines[i].match(/^([A-Z_]+)<<(\S+)$/u);
    if (!heredoc) continue;
    const [, name, delimiter] = heredoc;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && lines[i] !== delimiter) {
      body.push(lines[i]);
      i += 1;
    }
    rendered[name] = body.join('\n');
  }
  return rendered;
}

describe('agent-lane.yml canonical prompt rendering', () => {
  it.each(DISPATCH_PIPELINES)(
    '%s: the rendered prompt carries this attempt exact claim marker',
    (pipeline) => {
      const { AGENT_PROMPT } = renderLaneDefaults({ pipeline });

      expect(AGENT_PROMPT).toContain(
        formatClaimMarker(
          formatAttemptId({ generation: 7, intentId: 'intent-contract-test' }),
        ),
      );
    },
  );

  it('omits the marker block entirely when no broker intent was supplied', () => {
    const { AGENT_PROMPT } = renderLaneDefaults({
      pipeline: 'claude',
      intentId: '',
    });

    expect(AGENT_PROMPT).not.toContain('attempt-claim');
    // The rest of the prompt still renders - a hand dispatch is not a
    // broken dispatch.
    expect(AGENT_PROMPT).toContain('$AGENT_DISPATCH_CONTEXT');
    expect(AGENT_PROMPT).toContain('$AGENT_PROTOCOL_PATH');
  });

  it('names the shared protocol path literally, not this step shell expansion', () => {
    const { AGENT_PROMPT } = renderLaneDefaults({ pipeline: 'claude' });

    // Both are env vars in the AGENT's shell. If the lane's heredoc ever
    // stops quoting them, they expand to empty here and the agent is told
    // to read `` - a silent, un-loud failure.
    expect(AGENT_PROMPT).toContain('`$AGENT_DISPATCH_CONTEXT`');
    expect(AGENT_PROMPT).toContain('`$AGENT_PROTOCOL_PATH`');
  });

  it('splices protocol-note into the reading order when a repo supplies one', () => {
    const note = 'then .agents/skills/homelab-agent/homelab-agent-protocol.md,';
    const { AGENT_PROMPT } = renderLaneDefaults({
      pipeline: 'claude',
      protocolNote: note,
    });

    expect(AGENT_PROMPT).toContain(`\`$AGENT_PROTOCOL_PATH\`, ${note}`);
  });

  it('leaves the reading order clean when no protocol-note is supplied', () => {
    const { AGENT_PROMPT } = renderLaneDefaults({ pipeline: 'claude' });

    expect(AGENT_PROMPT).toContain(
      '`$AGENT_PROTOCOL_PATH`, and follow them in',
    );
    expect(AGENT_PROMPT).not.toMatch(/,\s{2,}and follow them/u);
  });

  it('describes parking as flag-agnostic (#1528) rather than naming the issue-mode label/comment recipe', () => {
    const { AGENT_PROMPT } = renderLaneDefaults({ pipeline: 'claude' });
    expect(AGENT_PROMPT).toContain(
      "park per the protocol's parking rule for this dispatch",
    );
    expect(AGENT_PROMPT).not.toContain('maintainer-assignee recipe');
  });

  it.each(DISPATCH_PIPELINES)(
    '%s: the silent-stall wording uses that pipeline own label and redispatch command',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { AGENT_NO_DELIVERABLE_REASON } = renderLaneDefaults({ pipeline });

      expect(AGENT_NO_DELIVERABLE_REASON).toContain(`\`${contract.label}\``);
      expect(AGENT_NO_DELIVERABLE_REASON).toContain(
        `\`${contract.redispatchCommand}\``,
      );
      expect(AGENT_NO_DELIVERABLE_REASON).toContain('no deliverable');
    },
  );

  it('keeps the attempt-claim tail when a caller overrides the prompt body', () => {
    // sprinkles is the one repo whose task framing genuinely differs, and
    // the marker is the one string it must never be trusted to render.
    const { AGENT_PROMPT } = renderLaneDefaults({
      pipeline: 'claude',
      promptOverride: 'Do the sprinkles-specific thing.',
    });

    expect(AGENT_PROMPT).toContain('Do the sprinkles-specific thing.');
    expect(AGENT_PROMPT).toContain(
      formatClaimMarker(
        formatAttemptId({ generation: 7, intentId: 'intent-contract-test' }),
      ),
    );
    expect(AGENT_PROMPT).toContain('Commit and push before you end your turn.');
    // The overridden body replaces the default body, not adds to it.
    expect(AGENT_PROMPT).not.toContain('Work the routed anchor');
  });

  it('lets a caller override the silent-stall wording', () => {
    const { AGENT_NO_DELIVERABLE_REASON } = renderLaneDefaults({
      pipeline: 'claude',
      noDeliverableOverride: 'This repo says it differently.',
    });

    expect(AGENT_NO_DELIVERABLE_REASON).toBe('This repo says it differently.');
  });

  it('renders a different marker for a different attempt (not a fixed string)', () => {
    const first = renderLaneDefaults({
      pipeline: 'codex',
      generation: '2',
      intentId: 'intent-aaa',
    });
    const second = renderLaneDefaults({
      pipeline: 'codex',
      generation: '3',
      intentId: 'intent-bbb',
    });

    expect(first.AGENT_PROMPT).toContain(
      formatClaimMarker(
        formatAttemptId({ generation: 2, intentId: 'intent-aaa' }),
      ),
    );
    expect(second.AGENT_PROMPT).toContain(
      formatClaimMarker(
        formatAttemptId({ generation: 3, intentId: 'intent-bbb' }),
      ),
    );
    expect(first.AGENT_PROMPT).not.toEqual(second.AGENT_PROMPT);
  });
});
