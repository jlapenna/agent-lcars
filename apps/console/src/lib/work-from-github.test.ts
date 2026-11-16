import {
  serializedJsonBytes,
  WORK_DESCRIPTION_MAX_BYTES,
} from '@agent-lcars/dispatch-contracts';
import { taskSchema, WORK_PAYLOAD_MAX_BYTES } from '@agent-lcars/orchestrator';
import { workPayloadSchema } from '@agent-lcars/work';
import { describe, expect, it } from 'vitest';

import {
  githubOrigin,
  normalizeWorkPayload,
  truncatedDescription,
  workPayloadFromGithub,
} from './work-from-github';

describe('truncatedDescription', () => {
  it('returns every nonempty under-bound body byte-for-byte', () => {
    expect(truncatedDescription('  hello  ')).toBe('  hello  ');
  });

  it('falls back to a placeholder for a null or empty body', () => {
    expect(truncatedDescription(null)).toBe('(no description)');
    expect(truncatedDescription(undefined)).toBe('(no description)');
    expect(truncatedDescription('')).toBe('(no description)');
  });

  // GitHub caps issue and pull-request bodies at 65,536 characters. The
  // retired 16,384-character cap cut those; the byte budget holds them whole.
  it.each([
    ['ASCII', 'x'],
    ['3-byte UTF-8', '漢'],
    ['JSON-escaped newline', '\n'],
  ])('keeps a complete 65,536-character %s body whole', (_name, unit) => {
    const body = unit.repeat(65_536);
    expect(truncatedDescription(body)).toBe(body);
  });

  it('marks and shortens only a body past the serialized byte budget', () => {
    // A C0 control character serializes as a six-byte `\u00XX` escape, so
    // 65,536 of them exceed the budget: the one GitHub-sized shape that can.
    const body = '\u0001'.repeat(65_536);
    expect(serializedJsonBytes(body)).toBeGreaterThan(
      WORK_DESCRIPTION_MAX_BYTES,
    );
    const result = truncatedDescription(body);
    expect(result).toMatch(/truncated to \d+ of 65536 characters/u);
    expect(serializedJsonBytes(result)).toBeLessThanOrEqual(
      WORK_DESCRIPTION_MAX_BYTES,
    );
  });

  it('keeps an over-budget payload storable and says it was shortened', () => {
    const body = '\u0001'.repeat(65_536);
    const payload = normalizeWorkPayload({
      origin: { principal: 'workflow:member-automation', channel: 'api' },
      spec: {
        title: 'Dispatch exact GitHub body',
        description: body,
        pipeline: 'codex',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    });

    expect(payload.spec.description).not.toBe(body);
    expect(payload.spec.description).toContain('Read the full body');
    expect(workPayloadSchema.parse(payload)).toEqual(payload);
    expect(serializedJsonBytes(payload)).toBeLessThanOrEqual(
      WORK_PAYLOAD_MAX_BYTES,
    );
  });
});

describe('githubOrigin', () => {
  it('uses the required actor login', () => {
    expect(githubOrigin('jlapenna')).toEqual({
      principal: 'github:jlapenna',
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
        priority: 'normal',
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

  // A complete GitHub-sized multibyte body must yield a payload both
  // `@agent-lcars/work`'s workPayloadSchema and `taskSchema.work`
  // (@agent-lcars/orchestrator, the bound the store enforces) accept whole.
  it('keeps a complete 65,536-character multibyte body whole in a storable payload', () => {
    const body = '漢'.repeat(65_536);
    const payload = workPayloadFromGithub({
      title: 'Fix the thing',
      body,
      pipeline: 'claude',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });

    expect(payload.spec.description).toBe(body);
    expect(workPayloadSchema.parse(payload)).toEqual(payload);
    const task = taskSchema.parse({
      task: { repo: 'jlapenna/agent-lcars', issue: 7 },
      runCount: 0,
      consecutiveLost: 0,
      updatedAt: '2026-08-15T12:00:00.000Z',
      work: payload,
    });
    expect(serializedJsonBytes(task.work)).toBeLessThanOrEqual(
      WORK_PAYLOAD_MAX_BYTES,
    );
  });
});
