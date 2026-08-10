import { describe, expect, it } from 'vitest';

import {
  displayTitleMatchesAttempt,
  formatAttemptId,
  formatClaimMarker,
  formatDispatchMarker,
  parseAttemptId,
  parseClaimMarker,
  parseDispatchMarker,
  textCarriesClaim,
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

  it('round-trips', () => {
    const attempt = { generation: 12, intentId: 'issue-645.g12:1' };
    expect(parseAttemptId(formatAttemptId(attempt))).toEqual(attempt);
  });

  it('agrees with what the run title parses back out', () => {
    const attempt = { generation: 3, intentId: 'abc-1' };
    const title = `#645: Codex issue agent ${formatDispatchMarker(attempt)}`;
    expect(parseDispatchMarker(title)).toEqual(
      parseAttemptId(formatAttemptId(attempt)),
    );
  });

  it('rejects the empty ID a hand-triggered dispatch produces', () => {
    // Actions renders blank inputs as `g:`; treating that as generation 0 of
    // an empty intent would bind an unrelated run to a real ledger entry.
    expect(parseAttemptId('g:')).toBe(undefined);
  });

  it('is anchored, so it does not match an ID embedded in other text', () => {
    expect(parseAttemptId('#645: agent [dispatch:g3:abc]')).toBe(undefined);
  });

  it('tolerates a missing ID', () => {
    expect(parseAttemptId(undefined)).toBe(undefined);
    expect(parseAttemptId(null)).toBe(undefined);
  });
});

describe('formatClaimMarker', () => {
  it('renders a hidden HTML-comment marker carrying the attempt ID', () => {
    expect(formatClaimMarker('g1:intent-a')).toBe(
      '<!-- attempt-claim:g1:intent-a -->',
    );
  });
});

describe('parseClaimMarker', () => {
  it('recovers the attempt ID out of arbitrary artifact text', () => {
    const marker = formatClaimMarker('g7:issue-645.g7');
    expect(parseClaimMarker(`Fixed the widget.\n\n${marker}\n`)).toBe(
      'g7:issue-645.g7',
    );
  });

  it('returns undefined for text carrying no marker at all', () => {
    expect(parseClaimMarker('Fixed the widget.')).toBe(undefined);
  });

  it('tolerates missing text', () => {
    expect(parseClaimMarker(undefined)).toBe(undefined);
    expect(parseClaimMarker(null)).toBe(undefined);
  });
});

describe('textCarriesClaim', () => {
  it('matches text carrying this exact attempt id', () => {
    const body = `Evidence comment.\n\n${formatClaimMarker('g2:intent-a')}`;
    expect(textCarriesClaim(body, 'g2:intent-a')).toBe(true);
  });

  it('rejects a marker naming a different attempt - the whole point of an exact claim', () => {
    // A marker for some OTHER attempt must never satisfy this one, or a
    // stray/stale marker from an earlier or sibling run could certify a
    // run that produced nothing - exactly what #645 Phase 4 exists to rule
    // out.
    const body = `Evidence comment.\n\n${formatClaimMarker('g2:intent-b')}`;
    expect(textCarriesClaim(body, 'g2:intent-a')).toBe(false);
  });

  it('rejects text with no marker at all', () => {
    expect(textCarriesClaim('Evidence comment.', 'g2:intent-a')).toBe(false);
  });

  it('tolerates missing text', () => {
    expect(textCarriesClaim(undefined, 'g2:intent-a')).toBe(false);
    expect(textCarriesClaim(null, 'g2:intent-a')).toBe(false);
  });
});
