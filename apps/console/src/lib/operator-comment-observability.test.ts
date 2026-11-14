import { logger } from '@agent-lcars/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recordOperatorComment,
  recordOperatorTokenIssued,
} from './operator-comment-observability';

describe('recordOperatorComment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs only the bounded census contract', () => {
    const structured = vi
      .spyOn(logger, 'structured')
      .mockImplementation(() => undefined);

    recordOperatorComment('posted');
    recordOperatorComment('rejected_token');

    expect(structured.mock.calls).toEqual([
      [
        'info',
        'LCARS operator comment outcome',
        { component: 'lcars-operator-comment', outcome: 'posted' },
        { enrich: false },
      ],
      [
        'warn',
        'LCARS operator comment outcome',
        { component: 'lcars-operator-comment', outcome: 'rejected_token' },
        { enrich: false },
      ],
    ]);
  });

  it('adds the token age and GitHub reason to a rejection', () => {
    const structured = vi
      .spyOn(logger, 'structured')
      .mockImplementation(() => undefined);

    recordOperatorComment('rejected_token', {
      tokenAgeSeconds: 3600,
      githubMessage: 'Bad credentials',
    });

    expect(structured.mock.calls[0]?.[2]).toEqual({
      component: 'lcars-operator-comment',
      outcome: 'rejected_token',
      tokenAgeSeconds: 3600,
      githubMessage: 'Bad credentials',
    });
  });

  it("adds GitHub's request id and its registry's verdict on the token", () => {
    const structured = vi
      .spyOn(logger, 'structured')
      .mockImplementation(() => undefined);

    recordOperatorComment('rejected_token', {
      githubRequestId: 'ABCD:1234',
      tokenRecord: 'present',
      tokenRecordCreatedAt: '2026-11-11T19:00:52Z',
      tokenRecordExpiresAt: null,
    });

    expect(structured.mock.calls[0]?.[2]).toEqual({
      component: 'lcars-operator-comment',
      outcome: 'rejected_token',
      githubRequestId: 'ABCD:1234',
      tokenRecord: 'present',
      tokenRecordCreatedAt: '2026-11-11T19:00:52Z',
      tokenRecordExpiresAt: null,
    });
  });
});

describe('recordOperatorTokenIssued', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('describes the token GitHub issued without logging it', () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T06:00:00Z') });
    const structured = vi
      .spyOn(logger, 'structured')
      .mockImplementation(() => undefined);

    recordOperatorTokenIssued({ access_token: 'gho_secretsecretsecret' });
    recordOperatorTokenIssued({
      access_token: 'ghu_secretsecretsecret',
      expires_at: Date.parse('2026-11-12T14:00:00Z') / 1000,
      refresh_token: 'ghr_secretsecretsecret',
    });
    recordOperatorTokenIssued({ access_token: '0123456789abcdef' });

    expect(structured.mock.calls.map((call) => call[2])).toEqual([
      {
        component: 'lcars-operator-token',
        tokenKind: 'gho',
        expiresInSeconds: null,
        refreshable: false,
      },
      {
        component: 'lcars-operator-token',
        tokenKind: 'ghu',
        expiresInSeconds: 8 * 60 * 60,
        refreshable: true,
      },
      {
        component: 'lcars-operator-token',
        tokenKind: 'other',
        expiresInSeconds: null,
        refreshable: false,
      },
    ]);
    expect(JSON.stringify(structured.mock.calls)).not.toContain('secret');
  });
});
