import type { ItemState } from '@agent-lcars/orchestrator';

import {
  type AgentEvent,
  type AgentEventKind,
  agentEventSchema,
} from './agent-events';

/**
 * The `lcars:work` event kind for each state a native Work item can enter
 * (#3568). The orchestrator store writes one `agent-event` outbox entry per
 * transaction that changes the item's derived state (`itemStateEventOutbox`),
 * so an event fires only when the state actually changes:
 *
 * | Enters     | Kind          | Typical transition                              |
 * | ---------- | ------------- | ----------------------------------------------- |
 * | `running`  | `state`       | a reply or redispatch reopens a stopped item    |
 * | `parked`   | `needs-reply` | the run finished with `park`: a human must reply |
 * | `done`     | `done`        | the run (or its PR delivery) completed          |
 * | `failed`   | `done`        | the run failed, or lost runs spent their retries |
 * | `canceled` | `done`        | an operator canceled the run or closed the item |
 *
 * Every event carries the entered state as its `detail`. `done` is the
 * source's terminal kind and ends the subscription; a failed or canceled item
 * can be reopened by a reply or redispatch, and a new subscription then sees
 * the `state` event that reopened it. Moves between runs that leave the item
 * `running` (queueing, claims, an automatic retry of a lost run, a PR still
 * waiting for merge) are not state changes and send nothing.
 */
export const WORK_AGENT_EVENT_KIND = {
  running: 'state',
  parked: 'needs-reply',
  done: 'done',
  failed: 'done',
  canceled: 'done',
} as const satisfies Record<ItemState, AgentEventKind<'lcars:work'>>;

/**
 * The event telling subscribers of `lcars:work:<workId>` that the item
 * entered `state`. `link` is the console's Work item page, set only when the
 * console is served over https. No `actor`: the store sees a transition, not
 * the principal that caused it. Throws when the result is not a valid event.
 */
export function workAgentEvent(input: {
  workId: string;
  /** Stable per transition (`workAgentEventId`). */
  eventId: string;
  state: ItemState;
  occurredAt: string;
  /** The console's base URL, such as `https://lcars.example.net`. */
  consoleUrl?: string;
}): AgentEvent {
  const link = workItemLink(input.consoleUrl, input.workId);
  return agentEventSchema.parse({
    id: input.eventId,
    key: `lcars:work:${input.workId}`,
    kind: WORK_AGENT_EVENT_KIND[input.state],
    occurredAt: input.occurredAt,
    detail: input.state,
    ...(link === undefined ? {} : { link }),
  });
}

function workItemLink(
  consoleUrl: string | undefined,
  workId: string,
): string | undefined {
  if (consoleUrl === undefined) return undefined;
  let base: URL;
  try {
    base = new URL(consoleUrl);
  } catch {
    return undefined;
  }
  if (base.protocol !== 'https:') return undefined;
  return `${base.origin}${base.pathname.replace(/\/+$/u, '')}/work/${encodeURIComponent(workId)}`;
}
