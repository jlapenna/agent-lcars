import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import {
  actionItemFromGithubAnchorProjection,
  parseObserveUntilMarker,
} from './action-items';

const baseAnchor: GithubAnchorProjection['anchor'] = {
  repo: 'jlapenna/agent-lcars',
  issue: 42,
};

function makeProjection(
  overrides: Partial<GithubAnchorProjection> = {},
): GithubAnchorProjection {
  return {
    anchor: baseAnchor,
    kind: 'issue',
    state: 'open',
    title: 'Homelab timer',
    body: '',
    url: 'https://github.com/jlapenna/agent-lcars/issues/42',
    labels: [],
    assigneeLogins: [],
    sourceUpdatedAt: '2026-09-15T00:00:00Z',
    observedAt: '2026-09-15T00:00:01Z',
    ...overrides,
  };
}

describe('parseObserveUntilMarker', () => {
  it('returns undefined for undefined text', () => {
    expect(parseObserveUntilMarker(undefined)).toBeUndefined();
  });

  it('returns undefined when the text carries no marker', () => {
    expect(parseObserveUntilMarker('just a regular comment')).toBeUndefined();
  });

  it('parses the ISO instant out of a well-formed marker', () => {
    expect(
      parseObserveUntilMarker(
        '<!-- agent-lcars:observe-until 2026-09-24T14:40:00Z -->',
      ),
    ).toBe('2026-09-24T14:40:00Z');
  });

  it('parses the marker embedded amid other prose', () => {
    expect(
      parseObserveUntilMarker(
        'Waiting on the nightly timer.\n' +
          '<!-- agent-lcars:observe-until 2026-09-24T14:40:00Z -->\n' +
          'Will post results after it fires.',
      ),
    ).toBe('2026-09-24T14:40:00Z');
  });

  it('rejects a marker whose value is not a valid ISO-8601 instant', () => {
    expect(
      parseObserveUntilMarker(
        '<!-- agent-lcars:observe-until sometime-next-week -->',
      ),
    ).toBeUndefined();
  });

  it('rejects a date-only value with no time component', () => {
    expect(
      parseObserveUntilMarker('<!-- agent-lcars:observe-until 2026-09-24 -->'),
    ).toBeUndefined();
  });

  it('rejects a numeric-offset instant - only Z-suffixed UTC is accepted', () => {
    expect(
      parseObserveUntilMarker(
        '<!-- agent-lcars:observe-until 2026-09-24T14:40:00+00:00 -->',
      ),
    ).toBeUndefined();
  });
});

describe('actionItemFromGithubAnchorProjection observeUntil', () => {
  it('is undefined when neither the body nor the last comment carries a marker', () => {
    const item = actionItemFromGithubAnchorProjection(
      makeProjection({ body: 'no marker here' }),
    );
    expect(item.observeUntil).toBeUndefined();
  });

  it('picks up a marker from the body', () => {
    const item = actionItemFromGithubAnchorProjection(
      makeProjection({
        body: '<!-- agent-lcars:observe-until 2026-09-24T14:40:00Z -->',
      }),
    );
    expect(item.observeUntil).toBe('2026-09-24T14:40:00Z');
  });

  it('picks up a marker from the last comment', () => {
    const item = actionItemFromGithubAnchorProjection(
      makeProjection({
        body: 'no marker here',
        lastComment: {
          body: '<!-- agent-lcars:observe-until 2026-09-24T14:40:00Z -->',
          url: 'https://github.com/jlapenna/agent-lcars/issues/42#comment-1',
        },
      }),
    );
    expect(item.observeUntil).toBe('2026-09-24T14:40:00Z');
  });

  it('takes the later of the two when both the body and the last comment carry a marker', () => {
    const item = actionItemFromGithubAnchorProjection(
      makeProjection({
        body: '<!-- agent-lcars:observe-until 2026-09-24T14:40:00Z -->',
        lastComment: {
          body: '<!-- agent-lcars:observe-until 2026-10-01T00:00:00Z -->',
          url: 'https://github.com/jlapenna/agent-lcars/issues/42#comment-1',
        },
      }),
    );
    expect(item.observeUntil).toBe('2026-10-01T00:00:00Z');
  });

  it('takes the body marker when it is later than the last comment', () => {
    const item = actionItemFromGithubAnchorProjection(
      makeProjection({
        body: '<!-- agent-lcars:observe-until 2026-10-01T00:00:00Z -->',
        lastComment: {
          body: '<!-- agent-lcars:observe-until 2026-09-24T14:40:00Z -->',
          url: 'https://github.com/jlapenna/agent-lcars/issues/42#comment-1',
        },
      }),
    );
    expect(item.observeUntil).toBe('2026-10-01T00:00:00Z');
  });
});
