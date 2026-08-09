import {
  HOSTED_COMPLETION_URL,
  isDispatchOutcomeKind,
  isLaneReadinessFailure,
} from '@agent-lcars/dispatch-contracts';

import type { HostedCompletionPayload } from '../hosted-completion-client';

export interface CompletionProcessingInput {
  issue: string;
  generation: string;
  intentId: string;
  token: string;
  workflow: string;
  oidcRequestUrl: string;
  oidcRequestToken: string;
  outcome?: string;
  outcomeReference?: string;
  readinessFailure?: string;
}

export interface CompletionProcessingDependencies {
  send(input: {
    completionUrl: string;
    oidcRequestUrl: string;
    oidcRequestToken: string;
    payload: HostedCompletionPayload;
  }): Promise<void>;
}

export interface CompletionProcessingResult {
  payload: HostedCompletionPayload;
}

export async function processCompletionCallback(
  input: CompletionProcessingInput,
  dependencies: CompletionProcessingDependencies,
): Promise<CompletionProcessingResult> {
  const outcome = input.outcome;
  const readinessFailure = input.readinessFailure;
  if (outcome && !isDispatchOutcomeKind(outcome)) {
    throw new Error('BROKER_OUTCOME_KIND is not a recognized outcome');
  }
  if (readinessFailure && !isLaneReadinessFailure(readinessFailure)) {
    throw new Error(
      'BROKER_READINESS_FAILURE is not a recognized readiness failure',
    );
  }
  if (input.outcomeReference) {
    const number = Number(input.outcomeReference);
    if (
      outcome !== 'pull-request' ||
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      throw new Error(
        'BROKER_OUTCOME_REFERENCE requires a positive PR number and pull-request outcome',
      );
    }
  }

  const payload: HostedCompletionPayload = {
    issue: Number(input.issue),
    generation: Number(input.generation),
    intentId: input.intentId,
    token: input.token,
    workflow: input.workflow,
    ...(outcome && isDispatchOutcomeKind(outcome) ? { outcome } : {}),
    ...(input.outcomeReference
      ? {
          outcomeReference: {
            kind: 'pull-request' as const,
            number: Number(input.outcomeReference),
          },
        }
      : {}),
    ...(readinessFailure && isLaneReadinessFailure(readinessFailure)
      ? { readinessFailure }
      : {}),
  };
  await dependencies.send({
    completionUrl: HOSTED_COMPLETION_URL,
    oidcRequestUrl: input.oidcRequestUrl,
    oidcRequestToken: input.oidcRequestToken,
    payload,
  });
  return { payload };
}
