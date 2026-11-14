import {
  CLAW_INVESTIGATE_OPERATION,
  PIPELINE_CONTRACTS,
  QUEUE_PRIORITIES,
} from '@agent-lcars/dispatch-contracts';
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
  Object.keys(PIPELINE_CONTRACTS) as ['claude', 'codex', 'opencode', 'agy'],
);

export const workTargetSchema = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
});

/** Ordered alternatives, explicitly supplied; omission/empty means no reroute. */
export const fallbackPipelinesSchema = z
  .array(z.enum(PIPELINES))
  .max(PIPELINES.length - 1)
  .refine((pipelines) => new Set(pipelines).size === pipelines.length, {
    message: 'Fallback pipelines must be unique',
  });

export const workSpecSchema = z
  .strictObject({
    title: z.string().min(1).max(WORK_TITLE_MAX),
    description: z.string().min(1).max(WORK_DESCRIPTION_MAX),
    /** Required: invoking a pipeline is a granted capability. */
    pipeline: z.enum(PIPELINES),
    /** Every operator may select priority; absence preserves historical FIFO. */
    priority: z.enum(QUEUE_PRIORITIES).default('normal'),
    fallbackPipelines: fallbackPipelinesSchema.optional(),
    /** Retired runtime-receipt policy; ignored. Still accepted because stored
     * items and schedules are immutable and some carry it. */
    deliveryRuntime: z.enum(['none', 'required']).optional(),
    /** Trusted immutable intake for read-only work whose result is findings,
     * not a change: the worker's final message is the report and the item
     * settles `done`. Omitted keeps PR/park/no-op as the only outcomes, so
     * implement work can never substitute a report. Temporary bridge to the
     * unified-dataflow `intent: report` (#2810), removed with its phase 2. */
    deliverable: z.enum(['report']).optional(),
    target: workTargetSchema,
  })
  .refine((spec) => !spec.fallbackPipelines?.includes(spec.pipeline), {
    path: ['fallbackPipelines'],
    message: 'Fallback pipelines must differ from the requested pipeline',
  });
export type WorkSpec = z.input<typeof workSpecSchema>;

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
  'linear',
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

export const SUMMARY_PIPELINES = Object.freeze([
  'inbox-summary',
  'handoff-summary',
] as const);
/** Internal `claw` agents executed as one k3s Job per attempt. Each is
 * bound to its operation by trusted configuration, never by source text. */
export const CLAW_PIPELINES = Object.freeze(['claw-investigator'] as const);
export type ClawPipeline = (typeof CLAW_PIPELINES)[number];
/** Every pipeline a stored Work spec can name: the public coding pipelines,
 * then internal recipe, summary and claw work. */
export const STORED_PIPELINES = Object.freeze([
  ...PIPELINES,
  'goose',
  ...SUMMARY_PIPELINES,
  ...CLAW_PIPELINES,
] as const);
export type StoredPipeline = (typeof STORED_PIPELINES)[number];

/** Internal reading work. Public coding admission continues to use workSpecSchema. */
export const summaryWorkSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: z.string().min(1).max(WORK_DESCRIPTION_MAX),
  pipeline: z.enum(SUMMARY_PIPELINES),
  priority: z.literal('background'),
  sourceKey: z.string().min(1).max(256),
});
export const recipeWorkSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: z.string().min(1).max(WORK_DESCRIPTION_MAX),
  pipeline: z.literal('goose'),
  priority: z.literal('background'),
  target: workTargetSchema,
  jobOccurrence: z.string().regex(/^[a-f0-9]{64}$/u),
});
/** Internal read-only investigation. It names no target: the agent reads
 * its zone, not a repository. It carries no question either: the stored
 * spec is immutable while a source key admits a new round per question, so
 * each round's question lives only in its revision input. Admitted only by the internal admission route
 * (`POST /claw/investigations`); public `create` validates `workSpecSchema`
 * and so rejects this shape. */
export const clawWorkSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: z.string().min(1).max(WORK_DESCRIPTION_MAX),
  pipeline: z.literal('claw-investigator'),
  priority: z.literal('background'),
  operation: z.literal(CLAW_INVESTIGATE_OPERATION),
  sourceKey: z.string().min(1).max(256),
});
export type ClawWorkSpec = z.infer<typeof clawWorkSpecSchema>;
export const storedWorkSpecSchema = z.union([
  workSpecSchema,
  summaryWorkSpecSchema,
  recipeWorkSpecSchema,
  clawWorkSpecSchema,
]);
export type StoredWorkSpec = z.infer<typeof storedWorkSpecSchema>;
export const storedWorkPayloadSchema = z.strictObject({
  origin: workOriginSchema,
  spec: storedWorkSpecSchema,
});

/** The stored claw spec of a Work payload, or undefined for every other
 * shape. Run routes use it to serve target-less claw runs without relaxing
 * the repository checks every other pipeline keeps. */
export function storedClawWorkSpec(payload: unknown): ClawWorkSpec | undefined {
  const parsed = storedWorkPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const claw = clawWorkSpecSchema.safeParse(parsed.data.spec);
  return claw.success ? claw.data : undefined;
}

/** What a reader needs from any stored spec shape. `repo` is absent for
 * internal summary and claw work, which reads a source rather than targeting one.
 * Undefined when the value matches no stored shape. */
export function readStoredWorkSpec(
  spec: unknown,
): { title: string; pipeline: StoredPipeline; repo?: string } | undefined {
  const parsed = storedWorkSpecSchema.safeParse(spec);
  if (!parsed.success) return undefined;
  const { title, pipeline } = parsed.data;
  return 'target' in parsed.data
    ? { title, pipeline, repo: parsed.data.target.repo }
    : { title, pipeline };
}

/** Event-owned operations advance through their source, never manual replies. */
export function isSourceManagedWork(payload: unknown): boolean {
  const parsed = storedWorkPayloadSchema.safeParse(payload);
  return (
    parsed.success &&
    ('sourceKey' in parsed.data.spec ||
      parsed.data.origin.principal === 'svc:fleet-triage')
  );
}
