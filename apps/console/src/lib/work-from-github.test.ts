import { describe, expect, it } from 'vitest';

import {
  githubOrigin,
  truncatedDescription,
  workPayloadFromGithub,
} from './work-from-github';

describe('truncatedDescription', () => {
  it('returns a short body verbatim, trimmed', () => {
    expect(truncatedDescription('  hello  ')).toBe('hello');
  });

  it('falls back to a placeholder for a null or empty body', () => {
    expect(truncatedDescription(null)).toBe('(no description)');
    expect(truncatedDescription(undefined)).toBe('(no description)');
    expect(truncatedDescription('   ')).toBe('(no description)');
  });

  it('clamps an overlong body with a truncation marker', () => {
    const body = 'x'.repeat(20_000);
    const result = truncatedDescription(body);
    expect(result.length).toBeGreaterThan(16_384);
    expect(result.startsWith('x'.repeat(16_384))).toBe(true);
    expect(result).toContain('truncated to 16384 of 20000 characters');
  });
});

describe('githubOrigin', () => {
  it('prefers the actor login', () => {
    expect(githubOrigin('jlapenna', 'agent:claude')).toEqual({
      principal: 'github:jlapenna',
      channel: 'github',
    });
  });

  it('falls back to the label when no actor is known', () => {
    expect(githubOrigin(undefined, 'agent:claude')).toEqual({
      principal: 'github:label:agent:claude',
      channel: 'github',
    });
  });

  it('falls back to unknown when neither actor nor label is known', () => {
    expect(githubOrigin(undefined, undefined)).toEqual({
      principal: 'github:unknown',
      channel: 'github',
    });
  });
});

describe('workPayloadFromGithub', () => {
  it('builds a full WorkPayload from an issue-shaped source', () => {
    expect(
      workPayloadFromGithub({
        title: 'Fix the thing',
        body: 'Please fix the thing.',
        pipeline: 'claude',
        repo: 'jlapenna/agent-lcars',
        actor: 'jlapenna',
      }),
    ).toEqual({
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Fix the thing',
        description: 'Please fix the thing.',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    });
  });

  it('clamps a title over WORK_TITLE_MAX defensively', () => {
    const title = 'y'.repeat(300);
    const payload = workPayloadFromGithub({
      title,
      body: 'b',
      pipeline: 'codex',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });
    expect(payload.spec.title).toBe('y'.repeat(256));
  });
});
