import { describe, expect, it } from 'vitest';

import {
  joinSessionTitleAnnotations,
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
    ...(title && { title }),
    ...(titleSource && { titleSource }),
    deliverables: { prNumbers: [1], commitShas: ['abc'] },
  };
}

describe('selectSessionTitle', () => {
  it('uses explicit, then annotation, then inferred precedence', () => {
    expect(
      selectSessionTitle({
        explicit: 'Native',
        annotation: annotation('s', 'Local'),
        inferred: 'Prompt',
      }),
    ).toEqual({ title: 'Native', source: 'explicit' });
    expect(
      selectSessionTitle({
        annotation: annotation('s', 'Local'),
        inferred: 'Prompt',
      }),
    ).toEqual({ title: 'Local', source: 'annotation' });
    expect(selectSessionTitle({ inferred: 'Prompt' })).toEqual({
      title: 'Prompt',
      source: 'inferred',
    });
  });

  it('falls through blank and malformed candidates', () => {
    expect(
      selectSessionTitle({
        explicit: ' ',
        annotation: { title: 'bad' },
        inferred: ' Prompt ',
      }),
    ).toEqual({ title: 'Prompt', source: 'inferred' });
    expect(
      selectSessionTitle({
        explicit: new Proxy(
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

describe('joinSessionTitleAnnotations', () => {
  it('inner-joins in discovered order and never fabricates sessions', () => {
    const discovered = [
      summary('first', 'Prompt', 'inferred'),
      summary('second', 'Native', 'explicit'),
      summary('third'),
    ];
    const result = joinSessionTitleAnnotations(discovered, [
      annotation('third', 'Third'),
      annotation('unknown', 'No session'),
    ]);
    expect(
      result.map(({ sessionId, title, titleSource }) => ({
        sessionId,
        title,
        titleSource,
      })),
    ).toEqual([
      { sessionId: 'first', title: 'Prompt', titleSource: 'inferred' },
      { sessionId: 'second', title: 'Native', titleSource: 'explicit' },
      { sessionId: 'third', title: 'Third', titleSource: 'annotation' },
    ]);
  });

  it('does not let an annotation replace an explicit native title', () => {
    expect(
      joinSessionTitleAnnotations(
        [summary('s', 'Native', 'explicit')],
        [annotation('s', 'Local')],
      )[0].title,
    ).toBe('Native');
  });

  it('fails closed for duplicate annotation identities and ignores timestamp order', () => {
    const discovered = [summary('s', 'Prompt', 'inferred')];
    expect(
      joinSessionTitleAnnotations(discovered, [
        annotation('s', 'new', '2026-08-16T00:00:00Z'),
        annotation('s', 'old', '2020-01-01T00:00:00Z'),
      ]),
    ).toEqual([discovered[0]]);
  });

  it('returns deeply detached values without mutating inputs', () => {
    const discovered = [summary('s', 'Prompt', 'inferred')];
    const before = structuredClone(discovered);
    const result = joinSessionTitleAnnotations(discovered, [
      annotation('s', 'Local'),
    ]);
    result[0].toolCallCounts.Bash = 99;
    result[0].tokens.inputTokens = 99;
    result[0].deliverables.prNumbers.push(99);
    expect(discovered).toEqual(before);
    expect(result).not.toBe(discovered);
    expect(result[0]).not.toBe(discovered[0]);
  });
});
