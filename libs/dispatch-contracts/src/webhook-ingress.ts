/** Stable identity of the one issue used by the real GitHub App ingress probe. */
export const WEBHOOK_INGRESS_CANARY_MARKER =
  '<!-- agent-lcars:webhook-ingress-canary:v1 -->';

export const WEBHOOK_INGRESS_CANARY_TITLE =
  'GitHub App webhook ingress canary sentinel';

export const WEBHOOK_INGRESS_CANARY_ACTIONS = ['closed', 'reopened'] as const;
export type WebhookIngressCanaryAction =
  (typeof WEBHOOK_INGRESS_CANARY_ACTIONS)[number];

export function isWebhookIngressCanaryAction(
  value: unknown,
): value is WebhookIngressCanaryAction {
  return WEBHOOK_INGRESS_CANARY_ACTIONS.includes(
    value as WebhookIngressCanaryAction,
  );
}
