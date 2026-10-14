import { describe, expect, it } from 'vitest';

import {
  investigationErrorSchema,
  investigationRequestSchema,
  investigationResultSchema,
} from './investigation-contract';

const request = {
  version: 1,
  runId: 'o/r#7/r2',
  requestId: 'same-request',
  question: 'Which unit?',
  context: '',
  issueUrl: 'https://github.com/o/r/issues/7',
};
describe('investigation wire handoff', () => {
  it('bounds UTF-8 input independently of UTF-16 character count', () => {
    expect(
      investigationRequestSchema.safeParse({
        ...request,
        question: 'é'.repeat(2048),
      }).success,
    ).toBe(true);
    expect(
      investigationRequestSchema.safeParse({
        ...request,
        question: 'é'.repeat(2049),
      }).success,
    ).toBe(false);
    expect(
      investigationRequestSchema.safeParse({
        ...request,
        context: 'é'.repeat(8193),
      }).success,
    ).toBe(false);
  });
  it('rejects caller authority, unknown fields and unbounded request keys', () => {
    expect(
      investigationRequestSchema.safeParse({ ...request, token: 'secret' })
        .success,
    ).toBe(false);
    expect(
      investigationRequestSchema.safeParse({ ...request, requestId: 'bad/key' })
        .success,
    ).toBe(false);
    expect(
      investigationRequestSchema.safeParse({
        ...request,
        requestId: 'x'.repeat(129),
      }).success,
    ).toBe(false);
  });
  it('keeps explicit unanswered findings and central audit uncertainty', () => {
    expect(
      investigationResultSchema.parse({
        version: 1,
        runId: request.runId,
        requestId: request.requestId,
        investigationId: '00000000-0000-4000-8000-000000000001',
        findings: [],
        confidence: 0,
        could_not_answer: ['no-probe-exists:missing-read'],
        audit_delivery: { journal: 'retained', loki: 'unknown' },
      }).could_not_answer,
    ).toEqual(['no-probe-exists:missing-read']);
  });
  it('does not promote an unaudited successful answer or raw extra data', () => {
    const answer = {
      version: 1,
      runId: request.runId,
      requestId: request.requestId,
      investigationId: '00000000-0000-4000-8000-000000000001',
      findings: [],
      confidence: 0,
      could_not_answer: [],
      audit_delivery: { journal: 'unknown', loki: 'unknown' },
    };
    expect(investigationResultSchema.safeParse(answer).success).toBe(false);
    expect(
      investigationResultSchema.safeParse({
        ...answer,
        audit_delivery: { journal: 'retained', loki: 'accepted' },
        transcript: 'raw',
      }).success,
    ).toBe(false);
  });
  it('bounds structured upstream diagnostics', () => {
    const error = {
      version: 1,
      requestId: null,
      error: { code: 'unauthorized', message: 'bounded', retryable: false },
    };
    expect(investigationErrorSchema.safeParse(error).success).toBe(true);
    expect(
      investigationErrorSchema.safeParse({
        ...error,
        error: { ...error.error, message: 'é'.repeat(257) },
      }).success,
    ).toBe(false);
  });
  it('preserves the actual typed probe UTC offset spelling', () => {
    const result = {
      version: 1,
      runId: request.runId,
      requestId: request.requestId,
      investigationId: '00000000-0000-4000-8000-000000000001',
      findings: [
        {
          finding: 'actual typed fact',
          confidence: 1,
          evidence: [
            {
              id: 'probe-1',
              ts: '2026-10-14T09:00:00+00:00',
              host: 'declared-host',
              probe: 'declared-probe',
              exit: 0,
              truncated: false,
              audit_delivery: { journal: 'retained', loki: 'accepted' },
              excerpt: 'typed',
            },
          ],
        },
      ],
      confidence: 1,
      could_not_answer: [],
      audit_delivery: { journal: 'retained', loki: 'accepted' },
    };
    expect(
      investigationResultSchema.parse(result).findings[0].evidence[0].ts,
    ).toBe('2026-10-14T09:00:00+00:00');
    expect(
      investigationResultSchema.safeParse({
        ...result,
        findings: [
          {
            ...result.findings[0],
            evidence: [{ ...result.findings[0].evidence[0], ts: 'not-a-time' }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
