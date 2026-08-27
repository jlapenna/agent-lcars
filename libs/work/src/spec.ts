import { PIPELINE_CONTRACTS } from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

/**
 * What a native work item asks for. Owned here, stored opaquely by the
 * orchestrator as `Task.work` (see the design spec, "Data model"), and
 * delivered to the worker as the `work` workflow input (Plan 3).
 */
export const WORK_TITLE_MAX = 256;
/** Fits the workflow_dispatch input budget (65,535 chars across all
 *  inputs) with room for the other inputs. */
export const WORK_DESCRIPTION_MAX = 16_384;

export const PIPELINES = Object.freeze(
  Object.keys(PIPELINE_CONTRACTS) as ['claude', 'codex', 'opencode'],
);

export const workTargetSchema = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
});

export const workSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: z.string().min(1).max(WORK_DESCRIPTION_MAX),
  /** Required: invoking a pipeline is a granted capability. */
  pipeline: z.enum(PIPELINES),
  target: workTargetSchema,
});
export type WorkSpec = z.infer<typeof workSpecSchema>;

export const workOriginSchema = z.strictObject({
  /** LCARS-native principal, e.g. `user:jlapenna`, `svc:lcars-admin`,
   *  `github:<login>` for a task derived from a GitHub webhook or console
   *  retrigger (sub-project 5). */
  principal: z.string().min(1).max(128),
  channel: z.enum(['api', 'cron', 'console', 'github']),
});
export type WorkOrigin = z.infer<typeof workOriginSchema>;

export const workPayloadSchema = z.strictObject({
  origin: workOriginSchema,
  spec: workSpecSchema,
});
export type WorkPayload = z.infer<typeof workPayloadSchema>;
