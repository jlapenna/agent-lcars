import { describe, expect, it } from 'vitest';

import {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  DISPATCH_PIPELINES,
  PIPELINE_CONTRACTS,
  pipelineContract,
  REPLY_COMMANDS,
  REVIEW_LABELS,
  WORKER_WORKFLOW_FILES,
} from './pipelines';

// These assert the literal values the registry replaced, on purpose. The
// point of the package is that six files stopped hand-writing these; the
// point of these tests is that the derivation still produces exactly what
// those files produced, so the migration is provably behavior-preserving
// rather than merely plausible.
describe('pipeline registry', () => {
  it('derives the dispatch pipeline list', () => {
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

  it('maps every reply command, aliases included', () => {
    expect([...REPLY_COMMANDS]).toEqual([
      ['@claude', 'claude'],
      ['/codex', 'codex'],
      ['/oc', 'opencode'],
      ['/opencode', 'opencode'],
    ]);
  });

  it('lists every worker workflow file', () => {
    expect([...WORKER_WORKFLOW_FILES]).toEqual([
      'claude.yml',
      'codex.yml',
      'opencode.yml',
    ]);
  });

  it('resolves a contract and rejects an unknown pipeline', () => {
    expect(pipelineContract('opencode').workflowFile).toBe('opencode.yml');
    expect(() => pipelineContract('gemini' as never)).toThrowError(
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
});

describe('registry invariants', () => {
  it('gives every agent pipeline a complete contract', () => {
    for (const pipeline of DISPATCH_PIPELINES) {
      const contract = pipelineContract(pipeline);
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
    const labels = [...AGENT_LABELS.keys(), ...REVIEW_LABELS.keys()];
    expect(new Set(labels).size).toBe(labels.length);
    expect(REPLY_COMMANDS.size).toBe(
      DISPATCH_PIPELINES.reduce(
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
    for (const pipeline of DISPATCH_PIPELINES) {
      const { redispatchCommand } = pipelineContract(pipeline);
      expect(REPLY_COMMANDS.get(redispatchCommand)).toBe(pipeline);
    }
  });

  it('freezes the registry against mutation', () => {
    expect(Object.isFrozen(PIPELINE_CONTRACTS)).toBe(true);
    expect(Object.isFrozen(PIPELINE_CONTRACTS.claude)).toBe(true);
  });
});
