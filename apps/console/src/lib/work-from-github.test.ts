import { taskSchema, WORK_PAYLOAD_MAX_BYTES } from '@agent-lcars/orchestrator';
import { WORK_DESCRIPTION_MAX, workPayloadSchema } from '@agent-lcars/work';
import { describe, expect, it } from 'vitest';

import {
  githubOrigin,
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

  // Item 3: `WORK_DESCRIPTION_MAX` (16,384) bounds *characters*, but
  // `taskSchema.work` (@agent-lcars/orchestrator) caps the SERIALIZED
  // payload at `WORK_PAYLOAD_MAX_BYTES` (32,768) UTF-8 *bytes*. A 3-bytes-
  // per-character body (CJK, etc.) can pack over ~10.9k characters into
  // that many bytes on its own -- comfortably under WORK_DESCRIPTION_MAX,
  // so the old character-only clamp left it untouched, and
  // `FirestoreStore.apply` would write it unvalidated for `readTask` to
  // then refuse forever.
  it('clamps a 3-bytes-per-char body that is under WORK_DESCRIPTION_MAX chars but over the payload byte budget', () => {
    // '漢' is 3 bytes in UTF-8: 12,000 chars is under WORK_DESCRIPTION_MAX
    // (16,384) but ~36,000 bytes on its own, already over
    // WORK_PAYLOAD_MAX_BYTES (32,768) before origin/title/JSON structure
    // are even counted.
    const body = '漢'.repeat(12_000);
    expect(body.length).toBeLessThan(WORK_DESCRIPTION_MAX);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(
      WORK_PAYLOAD_MAX_BYTES,
    );

    const result = truncatedDescription(body);
    expect(result.length).toBeLessThan(body.length);
    const resultBytes = new TextEncoder().encode(result).length;
    expect(resultBytes).toBeLessThan(WORK_PAYLOAD_MAX_BYTES);
    expect(result).toContain('12000 characters');
  });

  it('leaves a multi-byte body untouched when both bounds are satisfied', () => {
    const body = '漢'.repeat(1_000);
    expect(truncatedDescription(body)).toBe(body);
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

  // Item 3: a 3-bytes-per-char body at/over the real byte bound must yield
  // a payload BOTH schemas accept -- `@agent-lcars/work`'s workPayloadSchema
  // (character-bounded spec fields) AND `taskSchema.work`'s bound
  // (@agent-lcars/orchestrator, the serialized-UTF-8-byte cap the store
  // actually enforces).
  it('clamps a 3-bytes-per-char body so the derived payload satisfies both the character- and byte-bounded work schemas', () => {
    // 12,000 '漢' (3 bytes each) is under WORK_DESCRIPTION_MAX chars but
    // ~36,000 bytes on its own -- over the real WORK_PAYLOAD_MAX_BYTES
    // bound before title/origin/JSON structure are even counted.
    const payload = workPayloadFromGithub({
      title: 'Fix the thing',
      body: '漢'.repeat(12_000),
      pipeline: 'claude',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });

    // Character-bounded: @agent-lcars/work's own schema.
    expect(workPayloadSchema.parse(payload)).toEqual(payload);

    // Byte-bounded: the real bound `taskSchema.work` enforces on a
    // GITHUB-anchored task carrying this payload -- this is what
    // `FirestoreStore.apply` actually validates against.
    const task = taskSchema.parse({
      task: { repo: 'jlapenna/agent-lcars', issue: 7 },
      runCount: 0,
      updatedAt: '2026-08-15T12:00:00.000Z',
      work: payload,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(task.work)).length;
    expect(bytes).toBeLessThanOrEqual(WORK_PAYLOAD_MAX_BYTES);
  });
});
