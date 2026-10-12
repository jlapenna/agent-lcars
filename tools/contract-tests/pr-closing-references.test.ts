import { describe, expect, it, vi } from 'vitest';

import { checkClosingReferences } from '../../agents/shared/skills/agent-protocol/scripts/check-pr-closing-references.mjs';

const head = 'a6dd28c66db57faa082c565688ca68867a136955';
const scope = {
  repository: 'jlapenna/agent-lcars',
  number: 2447,
  head,
  complete: [],
};
const issue = (number: number, repository = scope.repository) => ({
  number,
  repository: { nameWithOwner: repository },
});
const page = (
  nodes: ReturnType<typeof issue>[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  data: {
    repository: {
      pullRequest: {
        state: 'OPEN',
        isDraft: false,
        headRefOid: head,
        closingIssuesReferences: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  },
});

describe('actual GitHub closing references versus declared completion', () => {
  it('rejects the #2447 interpreted-link counterexample despite negated prose', () => {
    const response = page([issue(2209)]);
    Object.assign(response.data.repository.pullRequest, {
      body: 'This PR supports the remaining runtime proof gate and intentionally does not close #2209.',
    });
    expect(() => checkClosingReferences(scope, () => response)).toThrow(
      'unintended [jlapenna/agent-lcars#2209]',
    );
  });

  it('accepts corrected partial scope and fully accepted intentional closure', () => {
    expect(
      checkClosingReferences(scope, () => page([])).closingIssuesReferences,
    ).toEqual([]);
    expect(
      checkClosingReferences(
        { ...scope, complete: ['jlapenna/agent-lcars#2209'] },
        () => page([issue(2209)]),
      ).closingIssuesReferences,
    ).toEqual(['jlapenna/agent-lcars#2209']);
  });

  it('still rejects an interpreted link after a body edit until actual readback clears', () => {
    const response = page([issue(2209)]);
    Object.assign(response.data.repository.pullRequest, {
      body: 'Tracks #2209',
    });
    expect(() => checkClosingReferences(scope, () => response)).toThrow(
      'unintended',
    );
  });

  it('checks every page and distinguishes cross-repository issue identities', () => {
    const request = vi
      .fn()
      .mockReturnValueOnce(page([], true, 'next'))
      .mockReturnValueOnce(page([issue(2209, 'jlapenna/homelab')]));
    expect(() =>
      checkClosingReferences(
        { ...scope, complete: ['jlapenna/agent-lcars#2209'] },
        request,
      ),
    ).toThrow(
      'unintended [jlapenna/homelab#2209]; missing [jlapenna/agent-lcars#2209]',
    );
    expect(request.mock.calls[1][0].endCursor).toBe('next');
  });

  it('accepts multi-page intentional scope and repository case differences', () => {
    const request = vi
      .fn()
      .mockReturnValueOnce(page([issue(123)], true, 'next'))
      .mockReturnValueOnce(page([issue(456)]));
    expect(
      checkClosingReferences(
        {
          ...scope,
          complete: ['JLapenna/Agent-LCARS#123', 'jlapenna/agent-lcars#456'],
        },
        request,
      ).closingIssuesReferences,
    ).toEqual(['jlapenna/agent-lcars#123', 'jlapenna/agent-lcars#456']);
  });

  it('refuses missing intended closure and absent explicit completion intent', () => {
    expect(() =>
      checkClosingReferences(
        { ...scope, complete: ['jlapenna/agent-lcars#2209'] },
        () => page([]),
      ),
    ).toThrow('missing [jlapenna/agent-lcars#2209]');
    expect(() =>
      checkClosingReferences({ ...scope, complete: undefined }, () => page([])),
    ).toThrow('Declare');
  });

  it.each(['head', 'closed', 'errors', 'missing', 'pagination', 'node'])(
    'fails closed on %s lookup failure',
    (failure) => {
      const response = page([], failure === 'pagination');
      const pr = response.data.repository.pullRequest;
      if (failure === 'head') pr.headRefOid = 'b'.repeat(40);
      if (failure === 'closed') pr.state = 'MERGED';
      if (failure === 'errors')
        Object.assign(response, { errors: [{ message: 'denied' }] });
      if (failure === 'missing')
        Object.assign(pr, { closingIssuesReferences: null });
      if (failure === 'node') pr.closingIssuesReferences.nodes = [issue(0)];
      expect(() => checkClosingReferences(scope, () => response)).toThrow();
    },
  );

  it('refuses a head change during pagination or a repeating cursor', () => {
    const changed = page([]);
    changed.data.repository.pullRequest.headRefOid = 'b'.repeat(40);
    const request = vi
      .fn()
      .mockReturnValueOnce(page([], true, 'next'))
      .mockReturnValueOnce(changed);
    expect(() => checkClosingReferences(scope, request)).toThrow(
      'expected head',
    );
    expect(() =>
      checkClosingReferences(scope, () => page([], true, 'same')),
    ).toThrow('pagination');
  });
});
