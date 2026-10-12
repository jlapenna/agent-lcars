/** Queue class vocabulary shared by intake and durable execution records.
 * Provider fairness and class weights belong to the orchestrator, not callers. */
export const QUEUE_PRIORITIES = Object.freeze([
  'urgent',
  'normal',
  'background',
] as const);
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];
