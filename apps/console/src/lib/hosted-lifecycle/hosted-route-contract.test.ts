import {
  buildRecoveryObservation,
  type RecoveryObservation,
  WORKER_WORKFLOW_FILES,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  assertHostedRecoveryObservationAuthority,
  HostedRouteContractError,
  parseHostedBearerToken,
  parseHostedCompletionRequestBody,
  parseHostedJsonBody,
  parseHostedReconcileRequestBody,
  parseHostedRecoveryObservationRequestBody,
} from './hosted-route-contract';

const workflow = [...WORKER_WORKFLOW_FILES][0];
const completion = {
  issue: 736,
  generation: 2,
  intentId: 'intent:abc123',
  token: 'abcdefghijklmnop',
  workflow,
  outcome: 'pull-request' as const,
  outcomeReference: { kind: 'pull-request' as const, number: 776 },
  readinessFailure: 'provider' as const,
};

const recoveryObservation: RecoveryObservation = buildRecoveryObservation({
  target: {
    domain: 'ci_retry',
    repositoryId: 1_307_149_765,
    repository: 'jlapenna/agent-lcars',
    anchor: 736,
    exactIdentity: 'run:93099054125:1',
  },
  sourceKind: 'webhook',
  observedAt: '2026-08-14T00:00:00.000Z',
  evidence: 'https://github.example.test/runs/93099054125',
});
const recoveryContext = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};

describe('hosted lifecycle route contract', () => {
  describe('parseHostedBearerToken', () => {
    it.each([
      null,
      '',
      'Basic abc',
      'bearer abcdefghijklmnop',
      'Bearer',
      'Bearer  abcdefghijklmnop',
      'Bearer abcdefghijklmnop ',
      'Bearer abc defghijklmnop',
      'Bearer one, Bearer two',
      'Bearer one\ttwo',
    ])('rejects malformed Authorization value %j', (header) => {
      expect(() => parseHostedBearerToken(header)).toThrow(
        HostedRouteContractError,
      );
    });

    it('returns the only non-whitespace token without normalization', () => {
      expect(parseHostedBearerToken('Bearer a_b-C.123')).toBe('a_b-C.123');
    });
  });

  describe('parseHostedCompletionRequestBody', () => {
    it('returns the typed strict completion body', () => {
      expect(parseHostedCompletionRequestBody(completion)).toEqual(completion);
    });

    it.each([
      ['extra field', { ...completion, attacker: true }],
      ['wrong issue type', { ...completion, issue: '736' }],
      ['wrong generation type', { ...completion, generation: '2' }],
      ['wrong workflow type', { ...completion, workflow: 123 }],
      ['malformed token', { ...completion, token: 'short' }],
      ['unpaired outcome reference', { ...completion, outcome: 'comment' }],
      [
        'malformed outcome reference',
        {
          ...completion,
          outcomeReference: { kind: 'pull-request', number: 0 },
        },
      ],
      ['malformed body', '{'],
      ['array body', []],
    ])('rejects %s', (_label, value) => {
      expect(() => parseHostedCompletionRequestBody(value)).toThrow(
        HostedRouteContractError,
      );
    });
  });

  it('rejects malformed JSON before the body parser runs', () => {
    const parser = vi.fn();
    expect(() => parseHostedJsonBody('{', parser)).toThrow(
      HostedRouteContractError,
    );
    expect(parser).not.toHaveBeenCalled();
  });

  describe('parseHostedRecoveryObservationRequestBody', () => {
    it('returns the typed strict recovery observation', () => {
      expect(
        parseHostedRecoveryObservationRequestBody(recoveryObservation),
      ).toEqual(recoveryObservation);
    });

    it.each([
      ['extra top-level field', { ...recoveryObservation, attacker: true }],
      [
        'extra target field',
        {
          ...recoveryObservation,
          target: { ...recoveryObservation.target, attacker: true },
        },
      ],
      [
        'wrong repository id type',
        {
          ...recoveryObservation,
          target: {
            ...recoveryObservation.target,
            repositoryId: '1',
          },
        },
      ],
      ['malformed body', '{'],
      ['array body', []],
    ])('rejects %s', (_label, value) => {
      expect(() => parseHostedRecoveryObservationRequestBody(value)).toThrow(
        HostedRouteContractError,
      );
    });

    it('requires repository identity to come from the verified context', () => {
      expect(
        assertHostedRecoveryObservationAuthority(
          parseHostedRecoveryObservationRequestBody(recoveryObservation),
          recoveryContext,
        ),
      ).toBe(recoveryObservation);
      expect(() =>
        assertHostedRecoveryObservationAuthority(
          parseHostedRecoveryObservationRequestBody({
            ...recoveryObservation,
            target: {
              ...recoveryObservation.target,
              repository: 'attacker/fork',
            },
          }),
          recoveryContext,
        ),
      ).toThrow(HostedRouteContractError);
      expect(() =>
        assertHostedRecoveryObservationAuthority(
          parseHostedRecoveryObservationRequestBody({
            ...recoveryObservation,
            target: {
              ...recoveryObservation.target,
              repositoryId: recoveryContext.repositoryId + 1,
            },
          }),
          recoveryContext,
        ),
      ).toThrow(HostedRouteContractError);
    });
  });

  describe('parseHostedReconcileRequestBody', () => {
    it('accepts the body-less reconcile command', () => {
      expect(parseHostedReconcileRequestBody(undefined)).toBeUndefined();
      expect(parseHostedReconcileRequestBody('')).toBeUndefined();
    });

    it.each([null, {}, [], '{'])('rejects a supplied body %j', (value) => {
      expect(() => parseHostedReconcileRequestBody(value)).toThrow(
        HostedRouteContractError,
      );
    });
  });
});
