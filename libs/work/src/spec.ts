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

/** The closed set of delivery channels a work item's origin may name.
 *  Exported so `work-grants.ts`'s optional per-grant `channel` is checked
 *  against this exact set rather than a second, driftable copy of the
 *  literals -- the same relationship `PIPELINES` already has with
 *  `workSpecSchema.pipeline`. */
export const WORK_CHANNELS = Object.freeze([
  'api',
  'cron',
  'console',
  'github',
  'slack',
] as const);

export const workOriginSchema = z.strictObject({
  /** LCARS-native principal, e.g. `user:jlapenna`, `svc:lcars-admin`,
   *  `github:<login>` for a task derived from a GitHub webhook or console
   *  retrigger (sub-project 5). */
  principal: z.string().min(1).max(128),
  channel: z.enum(WORK_CHANNELS),
  /** Opaque channel address the originating adapter uses to deliver this
   *  item's outcomes back to where it came from -- for Slack, the root
   *  message's `team/channel/ts`. Only that adapter interprets it; the
   *  control plane treats it as a string and never parses it. Written once
   *  with the rest of `work`, so `requestRun`'s write-once rule is
   *  unaffected. */
  thread: z.string().max(512).optional(),
});
export type WorkOrigin = z.infer<typeof workOriginSchema>;

export const workPayloadSchema = z.strictObject({
  origin: workOriginSchema,
  spec: workSpecSchema,
});
export type WorkPayload = z.infer<typeof workPayloadSchema>;
