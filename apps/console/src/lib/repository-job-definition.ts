import { createHash } from 'node:crypto';

import { fitsWorkDescription } from '@agent-lcars/dispatch-contracts';
import {
  credentialSetReferenceSchema,
  latestDueSlot,
  parseCron,
  PIPELINES,
  REPOSITORY_JOB_PARAMETERS_MAX_BYTES,
  repositoryJobJsonBytes,
  workDescriptionSchema,
} from '@agent-lcars/work';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  FIRESTORE_DOCUMENT_MAX_BYTES,
  firestoreDocumentBytes,
} from './firestore-document-size';
import { fileParameterRecipe } from './repository-job-recipe';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);
// Every complete allocation fits the per-Job k3s ceiling of 2 CPU, 6 GiB and
// 40 GiB that the QueueExecutor also enforces (`queueRuntimeCeiling`). A
// profile still has to match the deployed lane exactly (`authorizeJob`).
const allocation = z.strictObject({
  cpu: z
    .number()
    .min(0.2)
    .max(2)
    .refine((value) => Math.round(value * 1000) === value * 1000),
  memory: z.string().regex(/^[1-6]Gi$/u),
  storage: z
    .string()
    .regex(/^[1-9][0-9]*Gi$/u)
    .refine((value) => parseInt(value, 10) <= 40),
});
// Values reach Goose as parameter files, not argv, so only the bytes the
// occurrence document can hold bound them; there is no count or length cap.
export const jobInputsSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u), z.string())
  .refine((value) => !('baseline' in value), 'baseline is reserved')
  .refine(
    (value) =>
      repositoryJobJsonBytes(value) <= REPOSITORY_JOB_PARAMETERS_MAX_BYTES,
    `Parameters exceed ${REPOSITORY_JOB_PARAMETERS_MAX_BYTES / 1024} KiB`,
  );
const resourcesSchema = z
  .strictObject({ requests: allocation, limits: allocation })
  .refine(
    ({ requests, limits }) =>
      requests.cpu === limits.cpu &&
      requests.memory === limits.memory &&
      requests.storage === limits.storage,
    'requests must equal limits',
  );
const recipeParameterSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u),
  description: z.string().min(1),
  input_type: z.literal('string'),
  requirement: z.enum(['required', 'optional']),
  default: z.string().optional(),
});
export const gooseJobExecutionSchema = z.strictObject({
  recipe: z.literal('./recipe.yaml'),
  profile: name,
  timeout: z
    .string()
    .regex(/^[1-9][0-9]*m$/u)
    // The executor's Goose Pod deadline (50m) leaves the runner's own
    // timer room to report before the Pod is killed.
    .refine((value) => parseInt(value, 10) <= 45),
  maxAttempts: z.union([z.literal(1), z.literal(2)]),
  resources: resourcesSchema,
});
export const harnessJobExecutionSchema = z
  .strictObject({
    harness: z.enum(PIPELINES),
    fallbackHarnesses: z
      .array(z.enum(PIPELINES))
      .max(PIPELINES.length - 1)
      .refine(
        (harnesses) => new Set(harnesses).size === harnesses.length,
        'Fallback harnesses must be unique',
      )
      .optional(),
    prompt: z.literal('./prompt.md'),
    profile: name,
    timeout: z
      .string()
      .regex(/^[1-9][0-9]*m$/u)
      // Direct coding runners stay within the 90m Pod/provider envelope.
      .refine((value) => parseInt(value, 10) <= 80),
    maxAttempts: z.union([z.literal(1), z.literal(2)]),
    resources: resourcesSchema,
  })
  .refine(
    (exec) => !exec.fallbackHarnesses?.includes(exec.harness),
    'Fallback harnesses must differ from harness',
  );
export type JobExecution =
  | z.infer<typeof gooseJobExecutionSchema>
  | z.infer<typeof harnessJobExecutionSchema>;
export function isHarnessJobExecution(
  execution: JobExecution,
): execution is z.infer<typeof harnessJobExecutionSchema> {
  return 'harness' in execution;
}
export const repositoryJobSchema = z
  .strictObject({
    version: z.literal(1),
    description: z.string().min(1),
    triggers: z.strictObject({
      manual: z.boolean(),
      schedule: z
        .strictObject({
          cron: z
            .string()
            .max(64)
            .refine((value) => {
              try {
                parseCron(value);
                return true;
              } catch {
                return false;
              }
            }),
          timezone: z
            .string()
            .max(128)
            .refine((value) => {
              try {
                new Intl.DateTimeFormat('en-US', { timeZone: value });
                return true;
              } catch {
                return false;
              }
            }),
        })
        .optional(),
    }),
    execution: z.union([gooseJobExecutionSchema, harnessJobExecutionSchema]),
    inputs: jobInputsSchema,
    parameters: z.array(recipeParameterSchema).max(32).optional(),
    concurrency: z.strictObject({
      maxRuns: z.literal(1),
      overlap: z.literal('skip'),
    }),
    state: z.strictObject({ previousSuccessfulResult: z.boolean() }),
    result: z.union([
      z.strictObject({
        contract: z.literal('security-audit-v1'),
        requiredArtifacts: z.tuple([
          z.literal('report.md'),
          z.literal('findings.json'),
          z.literal('coverage.json'),
        ]),
      }),
      z.strictObject({
        contract: z.literal('json-v1'),
        requiredArtifacts: z.tuple([
          z.literal('report.md'),
          z.literal('result.json'),
        ]),
      }),
      z.strictObject({
        contract: z.literal('report-v1'),
        requiredArtifacts: z.tuple([z.literal('report.md')]),
      }),
      z.strictObject({
        contract: z.literal('deliverable-v1'),
        requiredArtifacts: z.tuple([z.literal('report.md')]),
      }),
    ]),
  })
  .superRefine((job, ctx) => {
    if (isHarnessJobExecution(job.execution)) {
      if (
        job.result.contract !== 'report-v1' &&
        job.result.contract !== 'deliverable-v1'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['result', 'contract'],
          message:
            'Harness jobs require report-v1 or deliverable-v1 result contract',
        });
      }
    } else {
      if (job.parameters !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameters'],
          message: 'Recipe jobs declare parameters in recipe.yaml',
        });
      }
      if (
        job.result.contract !== 'json-v1' &&
        job.result.contract !== 'security-audit-v1'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['result', 'contract'],
          message:
            'Recipe jobs require json-v1 or security-audit-v1 result contract',
        });
      }
    }
  });
export const jobDefinitionSchema = z.strictObject({
  repository,
  name,
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  job: repositoryJobSchema,
  recipeText: z.string(),
  parameters: z.array(recipeParameterSchema).default([]),
});
export type JobDefinition = z.infer<typeof jobDefinitionSchema>;
export const jobProfileNameSchema = name;
export const jobGitIdentitySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\r\n\0]+$/u),
  email: z.email().max(254),
});
export const jobProfileSchema = z
  .strictObject({
    name,
    repositories: z.array(repository).min(1),
    principals: z.array(z.string().min(1).max(128)).min(1),
    // Reuse ordinary watched-repository credentials only by operator opt-in.
    crossRepo: z.boolean().optional(),
    credentialSet: credentialSetReferenceSchema.optional(),
    // The harness a recipe's provider tools run on. Codex state is restored
    // through its existing leased broker; Claude and Antigravity (agy) use
    // executor-projected OAuth tokens. None is copied into a job credential set.
    providerAuth: z.enum(['codex', 'claude', 'agy']).optional(),
    // The model a harness without its own default runs (required for agy).
    providerModel: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u)
      .optional(),
    // When an occurrence under this profile stops on a provider limit (its
    // evaluator reports partialReason "provider-limit"), LCARS re-admits it
    // under this profile, e.g. the same recipe on another harness. A fallback
    // follows its own profile's fallbackProfile at most twice in total and
    // never returns to a profile the original already ran under.
    fallbackProfile: name.optional(),
    // Trusted output transport, independent of the model's final text. Deploy
    // runner support before activating this on a production profile.
    resultFile: z
      .string()
      .max(256)
      .regex(/^\/tmp\/[a-zA-Z0-9_./-]+\.json$/u)
      .refine((value) =>
        value
          .split('/')
          .slice(2)
          .every((part) => part && part !== '.' && part !== '..'),
      )
      .optional(),
    gitIdentity: jobGitIdentitySchema.optional(),
    allocation,
    // Exact approved input sets keep network and write scopes operator-owned.
    inputSets: z.array(jobInputsSchema).min(1),
  })
  .refine(
    (profile) => !(profile.credentialSet && profile.crossRepo),
    'Credential sets cannot be combined with crossRepo',
  )
  .refine(
    (profile) =>
      (profile.providerAuth === 'agy') ===
      (profile.providerModel !== undefined),
    'providerModel is required for, and only valid with, providerAuth agy',
  );
export type JobProfile = z.infer<typeof jobProfileSchema>;

export function jobDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function jobKey(repo: string, jobName: string): string {
  return jobDigest([repository.parse(repo), name.parse(jobName)]);
}
/** Catalog fields beside the definition: identity, state and a bounded error. */
const CATALOG_ENTRY_RESERVE_BYTES = 8 * 1024;
function yaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid YAML');
  return document.toJS({ maxAliasCount: 0 });
}
export function parseJobDefinition(
  repo: string,
  revision: string,
  jobName: string,
  jobText: string,
  recipeText: string,
): JobDefinition {
  const job = repositoryJobSchema.parse(yaml(jobText));
  let parameters: z.infer<typeof recipeParameterSchema>[];
  if (isHarnessJobExecution(job.execution)) {
    if (!recipeText.trim()) throw new Error('Prompt must not be empty');
    const declared = job.parameters ?? [];
    const keys = new Set(declared.map((parameter) => parameter.key));
    if (
      keys.size !== declared.length ||
      declared.some(
        (parameter) =>
          parameter.key === 'baseline' || parameter.key in job.inputs,
      )
    )
      throw new Error('Parameters must not duplicate fixed inputs or baseline');
    if (
      job.triggers.schedule &&
      declared.some(
        (parameter) =>
          parameter.requirement === 'required' &&
          parameter.default === undefined,
      )
    )
      throw new Error('Scheduled job parameters need defaults');
    parameters = declared;
  } else {
    const recipe = z
      .strictObject({
        version: z.literal('1.0.0'),
        title: z.string().min(1),
        description: z.string().min(1),
        prompt: z.string().min(1),
        instructions: z.string().optional(),
        // Goose's own recipe validation (v1.56 `MAX_PARAMETERS`) refuses more
        // than 32 declared parameters, the fixed inputs and baseline included,
        // and serialized declarations above 128 KiB. Mirror the executor's
        // limits here so the catalog shows the error instead of the run.
        parameters: z
          .array(recipeParameterSchema)
          .max(32)
          .refine(
            (value) => Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024,
            'Recipe parameter declarations exceed Goose 128 KiB limit',
          ),
        response: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(yaml(recipeText));
    const supplied = new Set([...Object.keys(job.inputs), 'baseline']);
    const declared = new Set(
      recipe.parameters.map((parameter) => parameter.key),
    );
    if (
      declared.size !== recipe.parameters.length ||
      [...supplied].some((key) => !declared.has(key))
    )
      throw new Error('Recipe must declare all fixed inputs and baseline');
    parameters = recipe.parameters.filter(
      (parameter) => !supplied.has(parameter.key),
    );
    if (
      job.triggers.schedule &&
      parameters.some(
        (parameter) =>
          parameter.requirement === 'required' &&
          parameter.default === undefined,
      )
    )
      throw new Error('Scheduled recipe parameters need defaults');
    // Workers pass every value as a Goose file parameter; refuse a recipe whose
    // declarations cannot be rewritten that way now, not at run time.
    fileParameterRecipe(recipeText);
  }
  const definition = jobDefinitionSchema.parse({
    repository: repo,
    revision,
    name: jobName,
    job,
    recipeText,
    parameters,
    digest: jobDigest([jobText, recipeText]),
  });
  if (isHarnessJobExecution(definition.job.execution)) {
    const sample = Object.fromEntries(
      definition.parameters.map((parameter) => [
        parameter.key,
        parameter.default ?? '',
      ]),
    );
    renderHarnessJobPrompt(definition, sample, null);
  }
  // The only size bound: the catalog entry embeds the definition as fields
  // (with room for the entry's own), and the occurrence store keeps it as one
  // JSON string, where escapes cost more. Both forms must fit a document.
  const id = '0'.repeat(64);
  if (
    firestoreDocumentBytes(`orchestrator-jobs/${id}`, { definition }) +
      CATALOG_ENTRY_RESERVE_BYTES >
      FIRESTORE_DOCUMENT_MAX_BYTES ||
    firestoreDocumentBytes(`orchestrator-job-definitions/${id}`, {
      json: JSON.stringify(definition),
    }) > FIRESTORE_DOCUMENT_MAX_BYTES
  )
    throw new Error("Job definition exceeds Firestore's 1 MiB document limit");
  return definition;
}
export function authorizeJob(
  definition: JobDefinition,
  profile: JobProfile | undefined,
  principal: string,
  profileName = definition.job.execution.profile,
): JobProfile {
  if (
    !profile ||
    profile.name !== profileName ||
    !profile.repositories.includes(definition.repository) ||
    !profile.principals.includes(principal)
  )
    throw new Error('Job profile not granted');
  const requested = definition.job.execution.resources.requests;
  if (JSON.stringify(requested) !== JSON.stringify(profile.allocation))
    throw new Error('Allocation must match profile exactly');
  const canonical = (value: Record<string, string>) =>
    JSON.stringify(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  if (
    !profile.inputSets.some(
      (value) => canonical(value) === canonical(definition.job.inputs),
    )
  )
    throw new Error('Input scope not granted');
  return profile;
}
export function jobDueAt(definition: JobDefinition, at: Date): boolean {
  const schedule = definition.job.triggers.schedule;
  if (!schedule) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const local = new Date(
    `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:00Z`,
  );
  return (
    latestDueSlot(
      parseCron(schedule.cron),
      local,
      new Date(local.getTime() - 60000),
    ) !== undefined
  );
}

/** Goose or manifest declares variable parameters; the manifest owns fixed execution scope. */
export function resolveJobParameters(
  definition: JobDefinition,
  values: Record<string, string>,
): Record<string, string> {
  jobInputsSchema.parse(values);
  const declared = new Map(
    definition.parameters.map((parameter) => [parameter.key, parameter]),
  );
  if (Object.keys(values).some((key) => !declared.has(key)))
    throw new Error('Unknown parameter or attempt to override fixed input');
  // Resolved defaults count too: the occurrence stores the resolved map.
  return jobInputsSchema.parse(
    Object.fromEntries(
      definition.parameters.map((parameter) => {
        const value = values[parameter.key] ?? parameter.default;
        if (value === undefined && parameter.requirement === 'required')
          throw new Error(`Missing recipe parameter: ${parameter.key}`);
        return [parameter.key, value ?? ''];
      }),
    ),
  );
}

/** Renders a native harness job's committed `prompt.md` with fixed inputs,
 *  resolved parameters and bounded prior baseline for the minted Work item. */
export function renderHarnessJobPrompt(
  definition: JobDefinition,
  parameters: Record<string, string>,
  baseline: unknown,
): string {
  const rawBaseline =
    baseline === null || baseline === undefined
      ? 'none'
      : typeof baseline === 'string'
        ? baseline
        : JSON.stringify(baseline);
  const build = (baselineText: string) => {
    const values: Record<string, string> = {
      ...parameters,
      ...definition.job.inputs,
      baseline: baselineText,
    };
    const rendered = definition.recipeText.replace(
      /\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,63})\s*\}\}/gu,
      (match, key: string) =>
        Object.hasOwn(values, key) ? values[key]! : match,
    );
    return `Repository job \`${definition.name}\` in \`${definition.repository}\` (pinned definition commit \`${definition.revision}\`, timeout \`${definition.job.execution.timeout}\`).\n\n${rendered}`;
  };
  let candidate = build(rawBaseline);
  if (!fitsWorkDescription(candidate) && rawBaseline.length > 1024) {
    candidate = build(
      `${rawBaseline.slice(0, 32 * 1024)}\n\n[… prior baseline truncated to fit Work description budget …]`,
    );
  }
  if (!fitsWorkDescription(candidate) && rawBaseline !== 'none') {
    candidate = build(
      '[prior baseline omitted to fit Work description budget]',
    );
  }
  if (!fitsWorkDescription(candidate) && rawBaseline !== 'none') {
    candidate = build('none');
  }
  return workDescriptionSchema.parse(candidate);
}
