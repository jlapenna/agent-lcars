import {
  fitsWorkDescription,
  PIPELINE_CONTRACTS,
  QUEUE_PRIORITIES,
  serializedJsonBytes,
  WORK_DESCRIPTION_TOO_LARGE,
  WORK_PAYLOAD_MAX_BYTES,
  WORK_PAYLOAD_TOO_LARGE,
} from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

/**
 * What a native work item asks for. Owned here, stored opaquely by the
 * orchestrator as `Task.work` (see the design spec, "Data model"), and
 * delivered to the worker as the `work` workflow input (Plan 3).
 */
/** GitHub's own issue and pull-request title limit. */
export const WORK_TITLE_MAX = 256;

/** A description has no character cap. Only its serialized size is bounded
 *  (`WORK_DESCRIPTION_MAX_BYTES`, `@agent-lcars/dispatch-contracts`), so the
 *  whole Work payload fits its Firestore budget. */
export const workDescriptionSchema = z
  .string()
  .min(1)
  .refine(fitsWorkDescription, {
    message: `Description ${WORK_DESCRIPTION_TOO_LARGE}`,
  });

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
    description: workDescriptionSchema,
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

const fitsWorkPayload = (payload: unknown) =>
  serializedJsonBytes(payload) <= WORK_PAYLOAD_MAX_BYTES;

export const workPayloadSchema = z
  .strictObject({
    origin: workOriginSchema,
    spec: workSpecSchema,
  })
  .refine(fitsWorkPayload, {
    message: `Work payload ${WORK_PAYLOAD_TOO_LARGE}`,
  });
export type WorkPayload = z.infer<typeof workPayloadSchema>;

export const SUMMARY_PIPELINES = Object.freeze([
  'inbox-summary',
  'handoff-summary',
] as const);
/** Every fixed pipeline a stored Work spec can name: the public coding
 * pipelines, then internal recipe and summary work. Claw work names its
 * executor runtime instead (`ClawRuntimePipeline`). */
export const STORED_PIPELINES = Object.freeze([
  ...PIPELINES,
  'goose',
  ...SUMMARY_PIPELINES,
] as const);
/** A repository-owned claw agent's pipeline: the executor runtime its
 * profile names (docs/repository-agents.md). */
export const CLAW_RUNTIME_PIPELINE = /^claw-[a-z0-9-]+$/u;
export type ClawRuntimePipeline = `claw-${string}`;
export type StoredPipeline =
  (typeof STORED_PIPELINES)[number] | ClawRuntimePipeline;

/** Internal reading work. Public coding admission continues to use workSpecSchema. */
export const summaryWorkSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: workDescriptionSchema,
  pipeline: z.enum(SUMMARY_PIPELINES),
  priority: z.literal('background'),
  sourceKey: z.string().min(1).max(256),
});
export const recipeWorkSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: workDescriptionSchema,
  pipeline: z.literal('goose'),
  priority: z.literal('background'),
  target: workTargetSchema,
  jobOccurrence: z.string().regex(/^[a-f0-9]{64}$/u),
});
/** A run of a repository-owned claw agent (docs/repository-agents.md). The
 * spec names the agent; each round's pinned definition and message live in
 * its revision input, so the immutable spec admits new rounds. */
export const agentWorkSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: workDescriptionSchema,
  priority: z.literal('background'),
  pipeline: z
    .string()
    .regex(CLAW_RUNTIME_PIPELINE)
    .transform((pipeline) => pipeline as ClawRuntimePipeline),
  /** `<owner>/<repo>/<name>`. */
  agent: z.string().regex(/^[\w.-]+\/[\w.-]+\/[a-z][a-z0-9-]*$/u),
  sourceKey: z.string().min(1),
});
export type AgentWorkSpec = z.infer<typeof agentWorkSpecSchema>;
/** Every claw run shape: target-less, executed as one k3s Job per attempt.
 * Only repository-owned agents remain (docs/repository-agents.md). */
export const clawWorkSpecSchema = agentWorkSpecSchema;
export type ClawWorkSpec = z.infer<typeof clawWorkSpecSchema>;
export const storedWorkSpecSchema = z.union([
  workSpecSchema,
  summaryWorkSpecSchema,
  recipeWorkSpecSchema,
  clawWorkSpecSchema,
]);
export type StoredWorkSpec = z.infer<typeof storedWorkSpecSchema>;
export const storedWorkPayloadSchema = z
  .strictObject({
    origin: workOriginSchema,
    spec: storedWorkSpecSchema,
  })
  .refine(fitsWorkPayload, {
    message: `Work payload ${WORK_PAYLOAD_TOO_LARGE}`,
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
