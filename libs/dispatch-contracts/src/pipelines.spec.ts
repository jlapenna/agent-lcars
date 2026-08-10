import { describe, expect, it } from 'vitest';

import {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  AGENT_PIPELINES,
  agentPipelineContract,
  DISPATCH_LABELS,
  DISPATCH_PIPELINES,
  excludedPullRequestAuthors,
  GENERIC_REPLY_COMMAND,
  PIPELINE_CONTRACTS,
  REPLY_COMMANDS,
  REVIEW_LABELS,
  WORKER_WORKFLOW_FILES,
  workerWorkflow,
} from './pipelines';

// These assert the literal values the registry replaced, on purpose. The
// point of the package is that six files stopped hand-writing these; the
// point of these tests is that the derivation still produces exactly what
// those files produced, so the migration is provably behavior-preserving
// rather than merely plausible.
describe('pipeline registry', () => {
  it('derives the agent and dispatch pipeline lists', () => {
    expect(AGENT_PIPELINES).toEqual(['claude', 'codex', 'opencode']);
    expect(DISPATCH_PIPELINES).toEqual(['claude', 'codex', 'opencode']);
  });

  it('derives the agent:* label map normalize.mjs used to hand-write', () => {
    expect([...AGENT_LABELS]).toEqual([
      ['agent:claude', 'claude'],
      ['agent:codex', 'codex'],
      ['agent:opencode', 'opencode'],
    ]);
  });

  it('derives the review:* label map', () => {
    expect([...REVIEW_LABELS]).toEqual([
      ['review:claude', 'claude'],
      ['review:codex', 'codex'],
      ['review:opencode', 'opencode'],
    ]);
  });

  it('derives reconcile discovery labels in agent-then-review order', () => {
    expect(DISPATCH_LABELS).toEqual([
      'agent:claude',
      'agent:codex',
      'agent:opencode',
      'review:claude',
      'review:codex',
      'review:opencode',
    ]);
  });

  it('maps every reply command, aliases included', () => {
    expect([...REPLY_COMMANDS]).toEqual([
      ['@claude', 'claude'],
      ['/codex', 'codex'],
      ['/oc', 'opencode'],
      ['/opencode', 'opencode'],
    ]);
  });

  it('keeps the pipeline-agnostic command out of the pipeline map', () => {
    // normalize.mjs composes it back in as a `null` sentinel; it must not
    // resolve to a pipeline here, or `@agent` would silently become one.
    expect(REPLY_COMMANDS.has(GENERIC_REPLY_COMMAND)).toBe(false);
  });

  it('lists every worker workflow file', () => {
    expect([...WORKER_WORKFLOW_FILES]).toEqual([
      'claude.yml',
      'codex.yml',
      'opencode.yml',
    ]);
  });

  it('resolves a worker workflow and rejects an unknown pipeline', () => {
    expect(workerWorkflow('opencode')).toBe('opencode.yml');
    expect(() => workerWorkflow('gemini' as never)).toThrowError(
      /Unsupported worker pipeline/u,
    );
  });
});

describe('bot identities', () => {
  it('deduplicates the shared codex/opencode login', () => {
    // codex and opencode both push as agent-lcars[bot]; this is the
    // acknowledged limitation behind verify-deliverable being unable to tell
    // their deliverables apart, so the list must be deduplicated, not
    // per-pipeline.
    expect(AGENT_BOT_LOGINS).toEqual(['claude[bot]', 'agent-lcars[bot]']);
  });

  it('excludes only the other pipelines pull request authors', () => {
    expect(excludedPullRequestAuthors('claude')).toEqual(['agent-lcars[bot]']);
    expect(excludedPullRequestAuthors('codex')).toEqual(['claude[bot]']);
    expect(excludedPullRequestAuthors('opencode')).toEqual(['claude[bot]']);
  });

  it('never excludes a pipeline from its own login', () => {
    for (const pipeline of AGENT_PIPELINES) {
      expect(excludedPullRequestAuthors(pipeline)).not.toContain(
        PIPELINE_CONTRACTS[pipeline].botLogin,
      );
    }
  });
});

describe('registry invariants', () => {
  it('gives every agent pipeline a complete contract', () => {
    for (const pipeline of AGENT_PIPELINES) {
      const contract = agentPipelineContract(pipeline);
      expect(contract.pipeline).toBe(pipeline);
      expect(contract.label).toBe(`agent:${pipeline}`);
      expect(contract.reviewLabel).toBe(`review:${pipeline}`);
      expect(contract.workflowFile).toBe(`${pipeline}.yml`);
      expect(contract.botLogin).toMatch(/\[bot\]$/u);
      expect(contract.runNameLabel).toBe(`${contract.displayName} issue agent`);
    }
  });

  it('keys every contract by its own pipeline name', () => {
    for (const pipeline of DISPATCH_PIPELINES) {
      expect(PIPELINE_CONTRACTS[pipeline].pipeline).toBe(pipeline);
    }
  });

  it('never lets two pipelines claim the same label or command', () => {
    expect(new Set(DISPATCH_LABELS).size).toBe(DISPATCH_LABELS.length);
    expect(REPLY_COMMANDS.size).toBe(
      AGENT_PIPELINES.reduce(
        (total, pipeline) =>
          total + 1 + PIPELINE_CONTRACTS[pipeline].replyTriggerAliases.length,
        0,
      ),
    );
  });

  it('accepts a redispatch command that the reply parser also accepts', () => {
    // opencode deliberately prints `/opencode` in failure comments while the
    // console offers `/oc`. Both must remain commands the broker recognizes,
    // or a failure comment would tell a human to type something inert.
    for (const pipeline of AGENT_PIPELINES) {
      const { redispatchCommand } = agentPipelineContract(pipeline);
      expect(REPLY_COMMANDS.get(redispatchCommand)).toBe(pipeline);
    }
  });

  it('freezes the registry against mutation', () => {
    expect(Object.isFrozen(PIPELINE_CONTRACTS)).toBe(true);
    expect(Object.isFrozen(PIPELINE_CONTRACTS.claude)).toBe(true);
  });
});
