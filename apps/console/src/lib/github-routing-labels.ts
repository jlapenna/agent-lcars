import { AGENT_LABELS, REVIEW_LABELS } from '@agent-lcars/dispatch-contracts';

import { UNIFIED_REVIEW_LABEL } from './pr-review-routing';

/** The complete label snapshot delivered by GitHub, not a live API lookup.
 * Explicit console/API and tagged-reply requests do not use label routing. */
export interface GithubLabelRouting {
  mode: 'implement' | 'review';
  trigger: string;
  labels: readonly { name: string }[] | undefined;
  /** Source clock and actor from the signed delivery; required for handoff. */
  requestedAt?: string;
  actor?: string;
  /** Set when cross-model review routing redirects a same-model review:* label
   * to the opposite reviewer so an agent never reviews its own PR. */
  crossModelOverride?: boolean;
}

export interface RoutingLabelConflict {
  kind: 'conflict';
  reason:
    | 'routing-label-conflict'
    | 'routing-labels-unavailable'
    | 'routing-label-snapshot-mismatch';
  namespace: 'agent' | 'review';
  labels: string[];
  message: string;
}

export function checkGithubLabelRouting(
  routing: GithubLabelRouting,
): RoutingLabelConflict | undefined {
  const namespace = routing.mode === 'implement' ? 'agent' : 'review';
  const choices = routing.mode === 'implement' ? AGENT_LABELS : REVIEW_LABELS;
  const isNamespaceChoice = (name: string) =>
    choices.has(name) ||
    (routing.mode === 'review' && name === UNIFIED_REVIEW_LABEL);
  const labels = [...new Set(routing.labels?.map((label) => label.name))]
    .filter(isNamespaceChoice)
    .sort();
  const resolution =
    'A maintainer must explicitly leave one routing choice in this namespace ' +
    'and reapply it to request work. Provider handoff requires authorization and ' +
    'settled physical ownership. Labels and assignees were not changed.';
  if (routing.labels === undefined) {
    return {
      kind: 'conflict',
      reason: 'routing-labels-unavailable',
      namespace,
      labels,
      message: `The complete ${namespace}:* label snapshot is missing. ${resolution}`,
    };
  }
  if (labels.length > 1) {
    return {
      kind: 'conflict',
      reason: 'routing-label-conflict',
      namespace,
      labels,
      message: `Conflicting ${namespace}:* choices: ${labels.join(', ')}. ${resolution}`,
    };
  }
  if (labels.length !== 1 || labels[0] !== routing.trigger) {
    return {
      kind: 'conflict',
      reason: 'routing-label-snapshot-mismatch',
      namespace,
      labels,
      message: `The triggering label ${routing.trigger} is not the sole ${namespace}:* choice in this snapshot. ${resolution}`,
    };
  }
  return undefined;
}
