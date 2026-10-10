import { AGENT_LABELS, REVIEW_LABELS } from '@agent-lcars/dispatch-contracts';

/** The complete label snapshot delivered by GitHub, not a live API lookup.
 * Explicit console/API and tagged-reply requests do not use label routing. */
export interface GithubLabelRouting {
  mode: 'implement' | 'review';
  trigger: string;
  labels: readonly { name: string }[] | undefined;
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
  const labels = [...new Set(routing.labels?.map((label) => label.name))]
    .filter((name) => choices.has(name))
    .sort();
  const resolution =
    'A maintainer must explicitly leave one routing choice in this namespace ' +
    'and reapply it to request work. Existing Work keeps its admitted pipeline; ' +
    'changing labels cannot reassign it. Labels and assignees were not changed.';
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
