import { describe, expect, it } from 'vitest';

import {
  formatAttemptId,
  formatClaimMarker,
  formatDispatchMarker,
  parseDispatchMarker,
} from './marker';

describe('formatDispatchMarker', () => {
  it('renders the marker the worker run-name embeds', () => {
    expect(formatDispatchMarker({ generation: 3, intentId: 'abc-123' })).toBe(
      '[dispatch:g3:abc-123]',
    );
  });

  it('renders Actions expressions so YAML can be pinned to this function', () => {
    // workflow-contract.test.mjs asserts the four `run-name:` templates
    // against this call rather than against another copy of the literal.
    expect(
      formatDispatchMarker({
        generation: '${{ inputs.broker_generation }}',
        intentId: '${{ inputs.broker_intent_id }}',
      }),
    ).toBe(
      '[dispatch:g${{ inputs.broker_generation }}:${{ inputs.broker_intent_id }}]',
    );
  });
});

describe('parseDispatchMarker', () => {
  it('round-trips a rendered marker out of a full run title', () => {
    const marker = formatDispatchMarker({
      generation: 12,
      intentId: 'issue-645.g12:1',
    });
    expect(parseDispatchMarker(`#645: Codex issue agent ${marker}`)).toEqual({
      generation: 12,
      intentId: 'issue-645.g12:1',
    });
  });

  it('round-trips an orchestrator run ID intent, which carries a repo and issue path', () => {
    // @agent-lcars/orchestrator mints run IDs as `{repo}#{issue}/r{generation}`
    // (e.g. `jlapenna/agent-lcars#1178/r1`); orchestrator-dispatch.ts's
    // outbox drain passes that runId verbatim as `broker_intent_id`, so it
    // becomes this marker's intentId unchanged, `/` and `#` included.
    const marker = formatDispatchMarker({
      generation: 1,
      intentId: 'jlapenna/agent-lcars#1178/r1',
    });
    expect(marker).toBe('[dispatch:g1:jlapenna/agent-lcars#1178/r1]');
    expect(parseDispatchMarker(`#1178: Claude issue agent ${marker}`)).toEqual({
      generation: 1,
      intentId: 'jlapenna/agent-lcars#1178/r1',
    });
  });

  it("stops the intent ID at the marker's own closing bracket rather than absorbing a `]` inside it", () => {
    // A pathological intentId containing `]` must not let the captured
    // group swallow the marker's own closing delimiter -- `]` is excluded
    // from the character class specifically so this fails safe (captures
    // only up to the first `]`) instead of over-capturing into whatever
    // text follows.
    expect(
      parseDispatchMarker(
        '#7: Claude issue agent [dispatch:g1:owner/repo#7]-trailing-noise]',
      ),
    ).toEqual({ generation: 1, intentId: 'owner/repo#7' });
  });

  it('ignores a hand-dispatched run with blank broker inputs', () => {
    // A manual workflow_dispatch leaves the inputs empty, which Actions
    // renders as `[dispatch:g:]`. Attributing that to generation 0 of an
    // empty intent would bind an unrelated run to a real ledger entry.
    expect(parseDispatchMarker('#645: Codex issue agent [dispatch:g:]')).toBe(
      undefined,
    );
  });

  it('ignores titles from before the broker rollout', () => {
    expect(parseDispatchMarker('#645: Codex issue agent')).toBe(undefined);
  });

  it('tolerates a missing title', () => {
    expect(parseDispatchMarker(undefined)).toBe(undefined);
    expect(parseDispatchMarker(null)).toBe(undefined);
  });
});

describe('the attempt ID', () => {
  it('is what the marker encodes, with no second definition', () => {
    // The whole reason attemptId is derived rather than minted: GitHub does
    // not return a run's dispatch inputs on the run object, so display_title
    // is the only channel a run and a ledger entry share. A separate minted
    // ID would have to go in the title too, and could then disagree with the
    // marker already there.
    const attempt = { generation: 7, intentId: 'issue-645.g7' };
    expect(formatDispatchMarker(attempt)).toBe(
      `[dispatch:${formatAttemptId(attempt)}]`,
    );
  });

  it('agrees with what the run title parses back out', () => {
    const attempt = { generation: 3, intentId: 'abc-1' };
    const title = `#645: Codex issue agent ${formatDispatchMarker(attempt)}`;
    expect(parseDispatchMarker(title)).toEqual(attempt);
  });

  it('renders an orchestrator run ID (owner/repo#issue/rN), not just the legacy charset', () => {
    const attempt = { generation: 1, intentId: 'jlapenna/agent-lcars#1178/r1' };
    expect(formatAttemptId(attempt)).toBe('g1:jlapenna/agent-lcars#1178/r1');
  });
});

describe('formatClaimMarker', () => {
  it('renders a hidden HTML-comment marker carrying the attempt ID', () => {
    expect(formatClaimMarker('g1:intent-a')).toBe(
      '<!-- attempt-claim:g1:intent-a -->',
    );
  });
});

describe('native run ids', () => {
  const intentId = 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1';

  it('round-trips a work: run id through the dispatch marker', () => {
    const marker = formatDispatchMarker({ generation: 1, intentId });
    expect(marker).toBe(`[dispatch:g1:${intentId}]`);
    expect(
      parseDispatchMarker(`native [dispatch:g1:${intentId}] title`),
    ).toEqual({
      generation: 1,
      intentId,
    });
  });
});
