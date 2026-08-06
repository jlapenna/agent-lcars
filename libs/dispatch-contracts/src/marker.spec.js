import { describe, expect, it } from 'vitest';

import {
  displayTitleMatchesAttempt,
  formatDispatchMarker,
  parseDispatchMarker,
} from './marker.js';

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

describe('displayTitleMatchesAttempt', () => {
  const attempt = { generation: 2, intentId: 'intent-a' };

  it('matches the exact generation that dispatched the run', () => {
    expect(
      displayTitleMatchesAttempt(
        '#7: Claude issue agent [dispatch:g2:intent-a]',
        attempt,
      ),
    ).toBe(true);
  });

  it('rejects a different generation of the same intent', () => {
    // The broker rebinds runs by this check; matching a neighbouring
    // generation would bind a superseded attempt's run to the live one.
    expect(
      displayTitleMatchesAttempt(
        '#7: Claude issue agent [dispatch:g3:intent-a]',
        attempt,
      ),
    ).toBe(false);
  });

  it('rejects a different intent at the same generation', () => {
    expect(
      displayTitleMatchesAttempt(
        '#7: Claude issue agent [dispatch:g2:intent-b]',
        attempt,
      ),
    ).toBe(false);
  });

  it('tolerates a missing title', () => {
    expect(displayTitleMatchesAttempt(undefined, attempt)).toBe(false);
  });
});
