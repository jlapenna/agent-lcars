import { describe, expect, it } from 'vitest';

import { resolveSessionId } from './session-id';

describe('resolveSessionId', () => {
  it('reports unset when none of the three variables are present', () => {
    expect(resolveSessionId({})).toEqual({ ok: false, reason: 'unset' });
  });

  it('prefers LCARS_SESSION_ID over the other two when all are present', () => {
    expect(
      resolveSessionId({
        LCARS_SESSION_ID: 'lcars-1',
        CLAUDE_CODE_SESSION_ID: 'claude-1',
        CODEX_THREAD_ID: 'codex-1',
      }),
    ).toEqual({ ok: true, sessionId: 'lcars-1', source: 'LCARS_SESSION_ID' });
  });

  it('falls back to CLAUDE_CODE_SESSION_ID when LCARS_SESSION_ID is absent', () => {
    expect(
      resolveSessionId({
        CLAUDE_CODE_SESSION_ID: 'claude-1',
        CODEX_THREAD_ID: 'codex-1',
      }),
    ).toEqual({
      ok: true,
      sessionId: 'claude-1',
      source: 'CLAUDE_CODE_SESSION_ID',
    });
  });

  it('falls back to CODEX_THREAD_ID when the first two are absent', () => {
    expect(resolveSessionId({ CODEX_THREAD_ID: 'codex-1' })).toEqual({
      ok: true,
      sessionId: 'codex-1',
      source: 'CODEX_THREAD_ID',
    });
  });

  it.each([
    ['LCARS_SESSION_ID', { LCARS_SESSION_ID: '../escape' }],
    ['CLAUDE_CODE_SESSION_ID', { CLAUDE_CODE_SESSION_ID: '-unsafe' }],
    ['CODEX_THREAD_ID', { CODEX_THREAD_ID: 'unsafe/id' }],
  ] as const)(
    'hard-fails on a present-but-unsafe %s instead of falling through',
    (source, env) => {
      expect(resolveSessionId(env)).toEqual({
        ok: false,
        reason: 'unsafe',
        source,
      });
    },
  );

  it('does not fall through to a safe lower-priority variable after an unsafe higher-priority one', () => {
    expect(
      resolveSessionId({
        LCARS_SESSION_ID: '../escape',
        CLAUDE_CODE_SESSION_ID: 'a-perfectly-safe-id',
      }),
    ).toEqual({ ok: false, reason: 'unsafe', source: 'LCARS_SESSION_ID' });
  });

  it('treats an explicit empty string as present-but-unsafe, not absent', () => {
    expect(resolveSessionId({ LCARS_SESSION_ID: '' })).toEqual({
      ok: false,
      reason: 'unsafe',
      source: 'LCARS_SESSION_ID',
    });
  });

  it('never merges an injected env with the real process.env', () => {
    process.env['CODEX_THREAD_ID'] = 'ambient-real-env-value';
    try {
      expect(resolveSessionId({})).toEqual({ ok: false, reason: 'unset' });
    } finally {
      delete process.env['CODEX_THREAD_ID'];
    }
  });

  it('defaults to the real process.env only when the argument is omitted', () => {
    process.env['LCARS_SESSION_ID'] = 'real-env-session';
    try {
      expect(resolveSessionId()).toEqual({
        ok: true,
        sessionId: 'real-env-session',
        source: 'LCARS_SESSION_ID',
      });
    } finally {
      delete process.env['LCARS_SESSION_ID'];
    }
  });
});
