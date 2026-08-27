import { WORK_DESCRIPTION_MAX, workPayloadSchema } from '@agent-lcars/work';
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

  it('leaves a body exactly at the bound untouched', () => {
    const body = 'x'.repeat(WORK_DESCRIPTION_MAX);
    expect(truncatedDescription(body)).toBe(body);
  });

  it('clamps an overlong body to exactly the bound, with a truncation marker', () => {
    const body = 'x'.repeat(20_000);
    const result = truncatedDescription(body);
    expect(result.length).toBe(WORK_DESCRIPTION_MAX);
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

  it('clamps a title over WORK_TITLE_MAX defensively, producing a valid payload', () => {
    const title = 'y'.repeat(300);
    const payload = workPayloadFromGithub({
      title,
      body: 'b',
      pipeline: 'codex',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });
    expect(payload.spec.title).toBe('y'.repeat(256));
    expect(workPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('clamps an overlong body to exactly the description bound and stays valid', () => {
    const payload = workPayloadFromGithub({
      title: 'Fix the thing',
      body: 'x'.repeat(20_000),
      pipeline: 'claude',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });
    expect(payload.spec.description.length).toBe(WORK_DESCRIPTION_MAX);
    expect(workPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('leaves a body exactly at the description bound untouched and valid', () => {
    const body = 'x'.repeat(WORK_DESCRIPTION_MAX);
    const payload = workPayloadFromGithub({
      title: 'Fix the thing',
      body,
      pipeline: 'claude',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });
    expect(payload.spec.description).toBe(body);
    expect(workPayloadSchema.parse(payload)).toEqual(payload);
  });
});
