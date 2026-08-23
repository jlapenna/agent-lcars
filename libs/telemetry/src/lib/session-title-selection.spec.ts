import { describe, expect, it } from 'vitest';

import {
  applySessionTitleOverlay,
  selectSessionTitle,
} from './session-title-selection';
import { SessionSummary } from './types';

const annotation = (
  sessionId: string,
  title: string,
  updatedAt = '2026-08-15T10:00:00Z',
) => ({
  version: 1 as const,
  sessionId,
  updatedAt,
  title,
});

function summary(
  sessionId: string,
  title?: string,
  titleSource?: SessionSummary['titleSource'],
): SessionSummary {
  return {
    sessionId,
    source: 'cli',
    startedAt: '2026-08-15T09:00:00Z',
    lastActivityAt: '2026-08-15T10:00:00Z',
    turns: 1,
    toolCallCounts: { Bash: 1 },
    tokens: {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    ...(title !== undefined && { title }),
    ...(titleSource && { titleSource }),
    deliverables: { prNumbers: [1], commitShas: ['abc'] },
  };
}

describe('selectSessionTitle', () => {
  it('uses declared, then generated, then inferred precedence', () => {
    expect(
      selectSessionTitle({
        declared: 'Declared',
        generated: 'Generated',
        inferred: 'Inferred',
      }),
    ).toEqual({ title: 'Declared', source: 'declared' });
    expect(
      selectSessionTitle({
        generated: 'Generated',
        inferred: 'Inferred',
      }),
    ).toEqual({ title: 'Generated', source: 'generated' });
    expect(selectSessionTitle({ inferred: 'Inferred' })).toEqual({
      title: 'Inferred',
      source: 'inferred',
    });
  });

  it('falls through blank and malformed candidates', () => {
    expect(
      selectSessionTitle({
        declared: ' ',
        generated: { title: 'not a string' },
        inferred: ' Prompt ',
      }),
    ).toEqual({ title: 'Prompt', source: 'inferred' });
    expect(selectSessionTitle({})).toBeUndefined();
  });

  it('ignores an oversized candidate only by truncating it, never by discarding it', () => {
    // Oversized is not malformed: truncateTitle's 80-char/ellipsis policy
    // still yields a non-blank string, so the candidate survives.
    const oversized = selectSessionTitle({ declared: 'x'.repeat(100) });
    expect(oversized?.title).toHaveLength(80);
    expect(oversized?.title.endsWith('…')).toBe(true);
    expect(oversized?.source).toBe('declared');
  });

  it('treats a candidate that is empty only after whitespace-collapse as absent', () => {
    expect(
      selectSessionTitle({ declared: '   \n\t  ', inferred: 'Prompt' }),
    ).toEqual({ title: 'Prompt', source: 'inferred' });
  });

  it('never throws for hostile reflective input, since candidates cross untrusted adapter boundaries', () => {
    expect(
      selectSessionTitle({
        declared: new Proxy(
          {},
          {
            get: () => {
              throw new Error('hostile');
            },
          },
        ),
      }),
    ).toBeUndefined();
  });
});

describe('applySessionTitleOverlay', () => {
  it("lets a declared annotation beat the summary's own generated title", () => {
    const original = summary('s', 'Native title', 'generated');
    const result = applySessionTitleOverlay(original, {
      declared: annotation('s', 'Declared title'),
    });
    expect(result.title).toBe('Declared title');
    expect(result.titleSource).toBe('declared');
  });

  it("lets a declared annotation beat the summary's own inferred title", () => {
    const original = summary('s', 'Prompt fragment', 'inferred');
    const result = applySessionTitleOverlay(original, {
      declared: annotation('s', 'Declared title'),
    });
    expect(result.title).toBe('Declared title');
    expect(result.titleSource).toBe('declared');
  });

  // This is the #1161-blocker-is-a-phantom proof: #1161 worried about
  // needing to delete a Firestore `title` field when a `declared` annotation
  // disappears. That state cannot occur here. The overlay is always applied
  // to a *pristine* reducer/adapter summary (never a previous overlay
  // result), so an absent `declared` candidate simply never gets to compete
  // — the summary's own transcript title (already present before the
  // overlay ran) survives untouched, because it was never provisionally
  // overwritten in the first place. There is no "was declared, now isn't"
  // transition to reconcile, so no deletion branch is ever reachable.
  it('#1161-blocker-is-a-phantom: a pristine summary with no declared annotation keeps its own transcript title unchanged', () => {
    // Not a by-reference return here — a real selection is still made
    // (the summary's own `generated` title, re-selected from itself), so
    // `applySessionTitleOverlay` produces a fresh object per its contract.
    // The point of this proof is the *value*: #1161 was worried about a
    // caller needing to delete a Firestore `title` field when a `declared`
    // annotation goes away. Nothing here ever computes an absent-title
    // state to delete — the transcript's own title simply keeps winning.
    const original = summary('s', 'Transcript title', 'generated');
    const result = applySessionTitleOverlay(original, {});
    expect(result.title).toBe('Transcript title');
    expect(result.titleSource).toBe('generated');
  });

  it('ignores malformed, oversized-but-truncatable, and empty-after-truncate candidates the same way selectSessionTitle does', () => {
    const original = summary('s', 'Transcript title', 'generated');

    // Empty-after-truncate: a declared annotation can never actually carry
    // a blank title (parseSessionTitleAnnotationV1 rejects it upstream),
    // but the overlay must not assume that and must degrade safely anyway.
    const blank = applySessionTitleOverlay(original, {
      declared: {
        version: 1,
        sessionId: 's',
        updatedAt: '2026-08-15T10:00:00Z',
        title: '',
      },
    });
    expect(blank.title).toBe('Transcript title');

    // Oversized survives via truncation, same as selectSessionTitle.
    const oversized = applySessionTitleOverlay(
      summary('s', undefined, undefined),
      {
        declared: annotation('s', 'x'.repeat(100)),
      },
    );
    expect(oversized.title).toHaveLength(80);
    expect(oversized.titleSource).toBe('declared');
  });

  it('returns the summary unchanged, by reference, when no candidate selects', () => {
    const original = summary('s');
    const result = applySessionTitleOverlay(original, {});
    expect(result).toBe(original);
  });

  it('never mutates the input summary or its overlay', () => {
    const original = summary('s', 'Transcript title', 'generated');
    const overlayInput = { declared: annotation('s', 'Declared title') };
    const before = structuredClone(original);
    const overlayBefore = structuredClone(overlayInput);

    const result = applySessionTitleOverlay(original, overlayInput);

    expect(original).toEqual(before);
    expect(overlayInput).toEqual(overlayBefore);
    expect(result).not.toBe(original);
    expect(result.title).toBe('Declared title');
  });
});
