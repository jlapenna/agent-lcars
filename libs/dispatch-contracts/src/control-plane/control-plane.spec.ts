import { describe, expect, it } from 'vitest';

import {
  acceptedAttemptSpecSchema,
  activationRecordSchema,
  agentResultClaimSchema,
  attemptOutcomeSchema,
  controlPlaneSignalEnvelopeSchema,
  credentialGrantIssuanceSchema,
  credentialGrantRequestSchema,
  credentialGrantResultSchema,
  githubTaskDisplayMetadataSchema,
  hasValidRuntimeObservationPayloadDigest,
  intentRevisionSchema,
  projectionIntentSchema,
  projectionStatusV1Schema,
  runBindingSchema,
  runtimeObservationEnvelopeSchema,
  runtimeObservationPayloadSha256,
} from './index';

const timestamp = '2026-08-13T12:00:00.000Z';
const renewalDeadline = '2026-08-13T12:45:00.000Z';
const tokenExpiresAt = '2026-08-13T13:00:00.000Z';
const sha = 'a'.repeat(64);
const attemptId = 'A'.repeat(22);
const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task = { tenantId: 'tenant-1', repositoryId: 123, issueNumber: 9 };
const centralActivation = {
  activationId: 'activation-1',
  taskClassId: 'github-issue',
  authorityEpoch: 1,
  mode: 'central-authoritative' as const,
};
const policy = {
  schema: 'agent-lcars.policy-decision/v1' as const,
  version: 1 as const,
  policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: sha },
  decision: 'accepted' as const,
  ruleId: 'rule-1',
  sourceFactId: 'fact-1',
  principal: { kind: 'github-actor' as const, actorId: 789, login: 'octocat' },
  evidenceRef: 'fact-1',
  decidedAt: timestamp,
};
const binding = {
  runId: 10,
  runAttempt: 1,
  checkRunId: 11,
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: sha,
};

function parse(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
) {
  return schema.safeParse(value).success;
}

describe('control-plane v1 contracts', () => {
  it('round-trips an authenticated, tenant-scoped signal', () => {
    const value = {
      schema: 'agent-lcars.control-plane-signal/v1',
      version: 1,
      requestId: 'request-1',
      factId: 'fact-1',
      tenant,
      task,
      receivedAt: timestamp,
      source: {
        kind: 'github-webhook',
        deliveryId: 'delivery-1',
        repositoryId: 123,
        installationId: 456,
        bodySha256: sha,
        event: 'issues',
        action: 'opened',
        actorId: 789,
        actorLogin: 'octocat',
        occurredAt: timestamp,
        hmacKeyVersion: 'key-v1',
      },
      signal: {
        kind: 'requested-work',
        mode: 'implement',
        requestKey: 'request-1',
      },
    };
    expect(controlPlaneSignalEnvelopeSchema.parse(value)).toEqual(value);
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        ...value,
        task: { ...task, repositoryId: 124 },
      }),
    ).toBe(false);
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        ...value,
        source: { ...value.source, installationId: 999 },
      }),
    ).toBe(false);
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        ...value,
        extraAuthority: true,
      }),
    ).toBe(false);
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        ...value,
        receivedAt: '2026-08-13T12:00:00-07:00',
      }),
    ).toBe(false);
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        ...value,
        source: { ...value.source, actorId: '789' },
      }),
    ).toBe(false);
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        ...value,
        signal: { kind: 'reconcile', scanKey: 'scan-1' },
      }),
    ).toBe(false);
    const pullRequestMetadata = {
      task,
      repository: tenant.repository,
      subject: { kind: 'pull-request', pullNumber: task.issueNumber },
    };
    expect(githubTaskDisplayMetadataSchema.parse(pullRequestMetadata)).toEqual(
      pullRequestMetadata,
    );
    expect(
      parse(githubTaskDisplayMetadataSchema, {
        ...pullRequestMetadata,
        subject: { kind: 'pull-request', pullNumber: task.issueNumber + 1 },
      }),
    ).toBe(false);
  });

  it('keeps accepted service attempt IDs distinct from local markers', () => {
    const value = {
      schema: 'agent-lcars.attempt-spec/v1',
      version: 1,
      requestId: 'request-1',
      attemptId,
      tenant,
      task,
      activation: centralActivation,
      local: {
        intentId: 'intent-1',
        generation: 2,
        attemptMarker: 'g2:intent-1',
        admissionRevision: 3,
        idempotencyKey: 'key-1',
      },
      execution: {
        workflowPath: '.github/workflows/worker.yml',
        workflowRef: 'refs/heads/main',
        workflowSha: sha,
        mode: 'implement',
        executorId: 'executor-1',
        credentialProfileId: 'profile-1',
        renewalDeadline: timestamp,
      },
      authorization: policy,
    };
    expect(acceptedAttemptSpecSchema.parse(value)).toEqual(value);
    expect(
      parse(acceptedAttemptSpecSchema, { ...value, attemptId: 'g2:intent-1' }),
    ).toBe(false);
    expect(
      parse(acceptedAttemptSpecSchema, {
        ...value,
        local: { ...value.local, attemptMarker: 'g02:intent-1' },
      }),
    ).toBe(false);
    expect(
      parse(acceptedAttemptSpecSchema, {
        ...value,
        authorization: { ...policy, decision: 'rejected' },
      }),
    ).toBe(false);
    expect(
      parse(acceptedAttemptSpecSchema, {
        ...value,
        activation: { ...centralActivation, mode: 'shadow' },
      }),
    ).toBe(false);
  });

  it('requires a complete exact run binding and scoped runtime fact', async () => {
    expect(runBindingSchema.parse(binding)).toEqual(binding);
    expect(
      parse(runBindingSchema, {
        ...binding,
        jobWorkflowRef: 'org/reusable@ref',
      }),
    ).toBe(false);
    expect(parse(runBindingSchema, { ...binding, runId: 0 })).toBe(false);
    const payload = {
      kind: 'run-terminal' as const,
      binding,
      conclusion: 'success' as const,
      observedAt: timestamp,
    };
    const observation = {
      schema: 'agent-lcars.runtime-observation/v1',
      version: 1,
      requestId: 'request-2',
      factId: 'fact-2',
      attemptId,
      tenant,
      task,
      source: { kind: 'github-provider', sourceId: 'provider-1' },
      observedAt: timestamp,
      payloadSha256: await runtimeObservationPayloadSha256(payload),
      payload,
    };
    const parsedObservation =
      runtimeObservationEnvelopeSchema.parse(observation);
    expect(parsedObservation).toEqual(observation);
    expect(
      await hasValidRuntimeObservationPayloadDigest(parsedObservation),
    ).toBe(true);
    expect(
      parse(runtimeObservationEnvelopeSchema, {
        ...observation,
        task: { ...task, tenantId: 'other' },
      }),
    ).toBe(false);
    expect(
      parse(runtimeObservationEnvelopeSchema, {
        ...observation,
        payloadSha256: 'not-a-digest',
      }),
    ).toBe(false);
    const { payloadSha256: _omitted, ...withoutPayloadDigest } = observation;
    expect(parse(runtimeObservationEnvelopeSchema, withoutPayloadDigest)).toBe(
      false,
    );
    expect(
      parse(runtimeObservationEnvelopeSchema, {
        ...observation,
        payload: { ...observation.payload, injectedAuthority: true },
      }),
    ).toBe(false);
    const changedPayload = {
      ...observation,
      payload: { ...observation.payload, conclusion: 'failure' as const },
    };
    const parsedChangedPayload =
      runtimeObservationEnvelopeSchema.parse(changedPayload);
    expect(
      await hasValidRuntimeObservationPayloadDigest(parsedChangedPayload),
    ).toBe(false);
  });

  it('rejects URL secret carriers for every durable artifact claim', () => {
    const url =
      'https://github.com/octo/example/pull/44?access_token=SECRET#token=SECRET';
    const claims = [
      {
        kind: 'pull-request',
        number: 44,
        url,
        localAttemptMarker: 'g2:intent-1',
      },
      {
        kind: 'comment',
        commentId: '1',
        url,
        localAttemptMarker: 'g2:intent-1',
      },
      {
        kind: 'review',
        reviewId: '2',
        pullNumber: 44,
        url,
        localAttemptMarker: 'g2:intent-1',
      },
      {
        kind: 'structured-no-op',
        commentId: '3',
        url,
        localAttemptMarker: 'g2:intent-1',
      },
    ];
    for (const claim of claims) {
      expect(parse(agentResultClaimSchema, claim)).toBe(false);
    }
  });

  it('validates outcome axes and exact claim correspondence', () => {
    const value = {
      schema: 'agent-lcars.attempt-outcome/v1',
      version: 1,
      attemptId,
      terminalState: 'succeeded',
      execution: 'exited',
      result: 'pull-request',
      reference: { kind: 'pull-request', number: 44 },
      evidence: {
        kind: 'validated-claim',
        validationFactId: 'validation-1',
        claim: {
          kind: 'pull-request',
          number: 44,
          localAttemptMarker: 'g2:intent-1',
        },
      },
      evidenceValidation: {
        status: 'validated',
        validationFactId: 'validation-1',
        validatedAt: timestamp,
      },
      finalizedAt: timestamp,
    };
    expect(attemptOutcomeSchema.parse(value)).toEqual(value);
    expect(parse(attemptOutcomeSchema, { ...value, result: 'comment' })).toBe(
      false,
    );
    const { reference: _reference, ...withoutReference } = value;
    expect(parse(attemptOutcomeSchema, withoutReference)).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...value,
        terminalState: 'cancelled',
        execution: 'cancelled',
        result: 'none',
      }),
    ).toBe(false);
    const providerCancelled = {
      ...value,
      terminalState: 'cancelled',
      execution: 'cancelled',
      result: 'none',
      reference: undefined,
      evidence: {
        kind: 'terminal-run',
        terminalFactId: 'terminal-1',
        binding,
      },
      evidenceValidation: { status: 'not-applicable' },
    };
    expect(parse(attemptOutcomeSchema, providerCancelled)).toBe(true);
    expect(
      parse(attemptOutcomeSchema, {
        ...providerCancelled,
        terminalState: 'superseded',
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...providerCancelled,
        execution: 'not_started',
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...value,
        reference: { kind: 'pull-request', number: 44, label: 'unsafe' },
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...value,
        failure: {
          owningSystem: 'finalizer',
          phase: 'validation',
          reason: 'deliverable_unattributable',
          retryDisposition: 'never',
        },
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...value,
        reference: { kind: 'pull-request', number: 45 },
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...value,
        evidenceValidation: {
          ...value.evidenceValidation,
          validationFactId: 'validation-2',
        },
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        ...value,
        terminalState: 'failed',
        result: 'none',
        reference: undefined,
        failure: {
          owningSystem: 'finalizer',
          phase: 'validation',
          reason: 'deliverable_absent',
          retryDisposition: 'never',
        },
        evidenceValidation: { status: 'not-applicable' },
      }),
    ).toBe(false);
  });

  it('keeps durable grant state token-free while returning an ephemeral token', () => {
    const issued = {
      grantId: 'grant-1',
      attemptId,
      requestId: 'request-3',
      credentialProfileId: 'profile-1',
      issuanceState: 'issued',
      mintState: 'minted',
      issuedAt: timestamp,
      tokenExpiresAt,
      maxResidualTokenExpiry: tokenExpiresAt,
      tokenFingerprint: sha,
    };
    expect(credentialGrantIssuanceSchema.parse(issued)).toEqual(issued);
    expect(
      parse(credentialGrantIssuanceSchema, { ...issued, token: 'secret' }),
    ).toBe(false);
    expect(
      parse(credentialGrantIssuanceSchema, {
        ...issued,
        mintState: 'mint-unknown',
      }),
    ).toBe(false);
    expect(
      parse(credentialGrantIssuanceSchema, {
        grantId: 'grant-2',
        attemptId,
        requestId: 'request-4',
        credentialProfileId: 'profile-1',
        issuanceState: 'pending',
        mintState: 'mint-in-progress',
      }),
    ).toBe(false);
    expect(
      credentialGrantIssuanceSchema.parse({
        grantId: 'grant-3',
        attemptId,
        requestId: 'request-5',
        credentialProfileId: 'profile-1',
        issuanceState: 'denied',
        mintState: 'mint-unknown',
        denialCode: 'mint_unknown',
        mintStartedAt: timestamp,
        maxResidualTokenExpiry: tokenExpiresAt,
      }).mintState,
    ).toBe('mint-unknown');
    expect(
      parse(credentialGrantIssuanceSchema, {
        grantId: 'grant-4',
        attemptId,
        requestId: 'request-6',
        credentialProfileId: 'profile-1',
        issuanceState: 'denied',
        mintState: 'not-started',
        denialCode: 'mint_unknown',
      }),
    ).toBe(false);
    expect(
      credentialGrantResultSchema.parse({
        kind: 'issued',
        token: 'ephemeral-token',
        grantId: 'grant-1',
        credentialProfileId: 'profile-1',
        issuedAt: timestamp,
        tokenExpiresAt,
        renewalDeadline,
        maxResidualTokenExpiry: tokenExpiresAt,
      }).kind,
    ).toBe('issued');
    expect(
      parse(credentialGrantIssuanceSchema, {
        ...issued,
        tokenExpiresAt: '2026-08-13T11:59:59.000Z',
      }),
    ).toBe(false);
    expect(
      parse(credentialGrantIssuanceSchema, {
        ...issued,
        maxResidualTokenExpiry: '2026-08-13T12:30:00.000Z',
      }),
    ).toBe(false);
    expect(
      parse(credentialGrantResultSchema, {
        kind: 'issued',
        token: 'ephemeral-token',
        grantId: 'grant-1',
        credentialProfileId: 'profile-1',
        issuedAt: timestamp,
        tokenExpiresAt,
        renewalDeadline: '2026-08-13T11:59:59.000Z',
        maxResidualTokenExpiry: tokenExpiresAt,
      }),
    ).toBe(false);
    expect(
      parse(credentialGrantResultSchema, {
        kind: 'issued',
        token: 'ephemeral-token',
        grantId: 'grant-1',
        credentialProfileId: 'profile-1',
        issuedAt: timestamp,
        tokenExpiresAt: '2026-08-13T13:00:00.001Z',
        renewalDeadline,
        maxResidualTokenExpiry: '2026-08-13T13:00:00.001Z',
      }),
    ).toBe(false);
    expect(
      parse(credentialGrantRequestSchema, {
        schema: 'agent-lcars.credential-grant-request/v1',
        version: 1,
        requestId: 'request-3',
        attemptId,
        credentialProfileId: 'caller-selected-profile',
      }),
    ).toBe(false);
  });

  it('keeps projection status orthogonal and activation effects explicit', () => {
    expect(
      parse(projectionIntentSchema, {
        schema: 'agent-lcars.projection-intent/v1',
        version: 1,
        operationId: 'operation-1',
        attemptId,
        kind: 'outcome-comment',
        desiredRevision: 1,
        payload: {
          kind: 'failure-park',
          failure: {
            owningSystem: 'controller',
            phase: 'launch',
            reason: 'launch_rejected',
            retryDisposition: 'never',
          },
        },
      }),
    ).toBe(false);
    expect(
      parse(projectionIntentSchema, {
        schema: 'agent-lcars.projection-intent/v1',
        version: 1,
        operationId: 'operation-1',
        attemptId,
        kind: 'outcome-comment',
        desiredRevision: 1,
        payload: { kind: 'outcome-comment', outcomeDigest: 'not-a-digest' },
      }),
    ).toBe(false);
    expect(
      parse(projectionStatusV1Schema, {
        operationId: 'operation-1',
        state: 'diverged',
        observedAt: timestamp,
      }),
    ).toBe(false);
    const shadow = {
      schema: 'agent-lcars.control-plane-activation/v1',
      version: 1,
      tenant,
      taskClassId: 'github-issue',
      activationId: 'activation-1',
      authorityEpoch: 1,
      effectiveBoundary: 4,
      mode: 'shadow',
      effectMode: 'none',
      recordedAt: timestamp,
    };
    expect(activationRecordSchema.parse(shadow)).toEqual(shadow);
    expect(
      parse(activationRecordSchema, { ...shadow, effectMode: 'enabled' }),
    ).toBe(false);
    expect(
      parse(activationRecordSchema, {
        ...shadow,
        mode: 'central-authoritative',
        effectMode: 'none',
      }),
    ).toBe(false);
  });

  it('rejects invalid numeric identity and contradictory intent policy', () => {
    expect(
      parse(controlPlaneSignalEnvelopeSchema, {
        schema: 'agent-lcars.control-plane-signal/v1',
        version: 1,
        requestId: 'request-4',
        factId: 'fact-4',
        tenant: { ...tenant, repositoryId: 0 },
        task,
        receivedAt: timestamp,
        source: {
          kind: 'schedule-reconcile',
          schedulerId: 'scheduler-1',
          scanKey: 'scan-1',
        },
        signal: { kind: 'reconcile', scanKey: 'scan-1' },
      }),
    ).toBe(false);

    const rejectedPolicy = { ...policy, decision: 'rejected' as const };
    expect(
      parse(intentRevisionSchema, {
        schema: 'agent-lcars.intent/v1',
        version: 1,
        task,
        intentId: 'intent-2',
        revision: 1,
        status: 'admitted',
        sourceFactId: 'fact-4',
        policyDecision: rejectedPolicy,
        activation: centralActivation,
        createdAt: timestamp,
      }),
    ).toBe(false);
    expect(
      parse(intentRevisionSchema, {
        schema: 'agent-lcars.intent/v1',
        version: 1,
        task,
        intentId: 'intent-3',
        revision: 1,
        status: 'admitted',
        sourceFactId: 'fact-4',
        policyDecision: policy,
        activation: centralActivation,
        createdAt: timestamp,
      }),
    ).toBe(false);
  });

  it('rejects free-text secret carriers from durable failure records', () => {
    const failureWithSecret = {
      owningSystem: 'worker',
      phase: 'bootstrap',
      reason: 'work_token_mint_failed',
      retryDisposition: 'never',
      detail: 'authorization: bearer secret-token',
    };
    expect(
      parse(runtimeObservationEnvelopeSchema, {
        schema: 'agent-lcars.runtime-observation/v1',
        version: 1,
        requestId: 'request-5',
        factId: 'fact-5',
        attemptId,
        tenant,
        task,
        source: { kind: 'actions-adapter', sourceId: 'adapter-1' },
        observedAt: timestamp,
        payloadSha256: sha,
        payload: { kind: 'adapter-failure', failure: failureWithSecret },
      }),
    ).toBe(false);
    expect(
      parse(projectionIntentSchema, {
        schema: 'agent-lcars.projection-intent/v1',
        version: 1,
        operationId: 'operation-2',
        attemptId,
        kind: 'failure-park',
        desiredRevision: 1,
        payload: { kind: 'failure-park', failure: failureWithSecret },
      }),
    ).toBe(false);
    expect(
      parse(attemptOutcomeSchema, {
        schema: 'agent-lcars.attempt-outcome/v1',
        version: 1,
        attemptId,
        terminalState: 'failed',
        execution: 'not_started',
        result: 'startup-failure',
        failure: failureWithSecret,
        evidence: { kind: 'no-deliverable', terminalFactId: 'fact-5' },
        evidenceValidation: { status: 'not-applicable' },
        finalizedAt: timestamp,
      }),
    ).toBe(false);
  });
});
