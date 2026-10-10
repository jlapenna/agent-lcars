import 'server-only';

import type { CapacityState } from '@agent-lcars/orchestrator';

const actions = new Set([
  'register',
  'configure',
  'recover',
  'authorize-producer',
  'bind',
  'attest',
  'worker-retired',
  'operation',
  'stop-producer',
  'retire',
  'release',
  'resolve-retired-write',
  'import',
  'claim',
  'activate',
  'validation',
]);
const reasons = new Set([
  'policy',
  'inventory',
  'capacity',
  'producer',
  'stale',
  'authority',
  'worker',
  'physical',
  'retired',
  'bounds',
]);
const transitions = new Map<string, number>();
const refusals = new Map<string, number>();
export function recordCapacityTransition(action: string) {
  if (actions.has(action))
    transitions.set(action, (transitions.get(action) ?? 0) + 1);
}
export function recordCapacityRefusal(reason: string) {
  if (reasons.has(reason))
    refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
}
const label = (value: string) =>
  `"${value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/"/gu, '\\"')}"`;

export async function capacityMetricsHttpResponse(
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  const metrics: unknown = await response.json();
  if (typeof metrics !== 'string')
    throw new Error('Invalid capacity metrics response');
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  headers.delete('content-length');
  return new Response(metrics, { status: response.status, headers });
}
/** Labels come from bounded declared pools/domains and closed protocol enums.
 * Missing datastore reads fail the request; missing samples never become zero. */
export function capacityMetrics(state: CapacityState, now: string): string {
  const lines = [
    '# HELP lcars_capacity_slots Current physical receipt occupancy.',
    '# TYPE lcars_capacity_slots gauge',
    '# HELP lcars_capacity_inventory_known Whether reviewed inventory is complete.',
    '# TYPE lcars_capacity_inventory_known gauge',
    '# HELP lcars_capacity_policy_version Declared server capacity version.',
    '# TYPE lcars_capacity_policy_version gauge',
    '# HELP lcars_capacity_quarantine_age_seconds Oldest quarantined receipt age.',
    '# TYPE lcars_capacity_quarantine_age_seconds gauge',
    '# HELP lcars_capacity_domain_workers Active attested provider execution permits.',
    '# TYPE lcars_capacity_domain_workers gauge',
    '# HELP lcars_capacity_domain_occupied Physical receipts occupying provider domains.',
    '# TYPE lcars_capacity_domain_occupied gauge',
    '# HELP lcars_capacity_transitions_total Successful application protocol calls since process startup.',
    '# TYPE lcars_capacity_transitions_total counter',
    '# HELP lcars_capacity_refusals_total Refused application protocol calls since process startup.',
    '# TYPE lcars_capacity_refusals_total counter',
  ];
  for (const policy of state.policies) {
    const receipts = state.receipts.filter(
      (receipt) => receipt.poolId === policy.poolId,
    );
    for (const status of [
      'unplaced',
      'placed',
      'retiring',
      'quarantined',
    ] as const)
      lines.push(
        `lcars_capacity_slots{pool=${label(policy.poolId)},state=${label(status)}} ${receipts.filter((receipt) => receipt.state === status).length}`,
      );
    if (policy.inventoryKnown)
      lines.push(
        `lcars_capacity_slots{pool=${label(policy.poolId)},state="free"} ${Math.max(0, policy.maxConcurrent - receipts.length)}`,
      );
    lines.push(
      `lcars_capacity_inventory_known{pool=${label(policy.poolId)}} ${Number(policy.inventoryKnown)}`,
    );
    lines.push(
      `lcars_capacity_policy_version{pool=${label(policy.poolId)}} ${policy.version}`,
    );
    const quarantined = receipts.filter(
      (receipt) => receipt.state === 'quarantined',
    );
    lines.push(
      `lcars_capacity_quarantine_age_seconds{pool=${label(policy.poolId)}} ${Math.max(0, ...quarantined.map((receipt) => (Date.parse(now) - Date.parse(receipt.claimedAt)) / 1000))}`,
    );
  }
  const domains = new Set(
    state.policies.flatMap((policy) =>
      Object.values(policy.domains).map((domain) => domain.domainId),
    ),
  );
  for (const domain of domains) {
    lines.push(
      `lcars_capacity_domain_workers{domain=${label(domain)}} ${state.receipts.filter((receipt) => receipt.domainId === domain && receipt.worker?.active).length}`,
    );
    const inventoryKnown = state.policies
      .filter(
        (policy) =>
          policy.enforced &&
          Object.values(policy.domains).some(
            (value) => value.domainId === domain,
          ),
      )
      .every((policy) => policy.inventoryKnown);
    if (inventoryKnown)
      lines.push(
        `lcars_capacity_domain_occupied{domain=${label(domain)}} ${state.receipts.filter((receipt) => receipt.domainId === domain).length}`,
      );
  }
  for (const [action, value] of transitions)
    lines.push(
      `lcars_capacity_transitions_total{action=${label(action)}} ${value}`,
    );
  for (const [reason, value] of refusals)
    lines.push(
      `lcars_capacity_refusals_total{reason=${label(reason)}} ${value}`,
    );
  return `${lines.join('\n')}\n`;
}
