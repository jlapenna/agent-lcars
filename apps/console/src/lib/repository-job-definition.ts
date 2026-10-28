import { createHash } from 'node:crypto';

import { latestDueSlot, parseCron } from '@agent-lcars/work';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);
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
    .refine((value) => parseInt(value, 10) <= 24),
});
export const jobInputsSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u),
    z.string().max(2048),
  )
  .refine((value) => Object.keys(value).length <= 32 && !('baseline' in value));
export const repositoryJobSchema = z.strictObject({
  version: z.literal(1),
  description: z.string().min(1).max(1024),
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
  execution: z.strictObject({
    recipe: z.literal('./recipe.yaml'),
    profile: name,
    timeout: z
      .string()
      .regex(/^[1-9][0-9]*m$/u)
      .refine((value) => parseInt(value, 10) <= 30),
    maxAttempts: z.literal(1),
    resources: z
      .strictObject({ requests: allocation, limits: allocation })
      .refine(
        ({ requests, limits }) =>
          requests.cpu === limits.cpu &&
          requests.memory === limits.memory &&
          requests.storage === limits.storage,
        'requests must equal limits',
      ),
  }),
  inputs: jobInputsSchema,
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
  ]),
});
const recipeParameterSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u),
  description: z.string().min(1),
  input_type: z.literal('string'),
  requirement: z.enum(['required', 'optional']),
  default: z.string().max(2048).optional(),
});
export const jobDefinitionSchema = z.strictObject({
  repository,
  name,
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  job: repositoryJobSchema,
  recipeText: z.string().max(65536),
  parameters: z.array(recipeParameterSchema).max(32).default([]),
});
export type JobDefinition = z.infer<typeof jobDefinitionSchema>;
export const jobProfileSchema = z.strictObject({
  name,
  repositories: z.array(repository).min(1),
  principals: z.array(z.string().min(1).max(128)).min(1),
  // Reuse ordinary watched-repository credentials only by operator opt-in.
  crossRepo: z.boolean().optional(),
  allocation,
  // Exact approved input sets keep network and write scopes operator-owned.
  inputSets: z.array(jobInputsSchema).min(1).max(100),
});
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
function yaml(text: string): unknown {
  if (Buffer.byteLength(text) > 65536)
    throw new Error('Document exceeds 64 KiB');
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
  const recipe = z
    .strictObject({
      version: z.literal('1.0.0'),
      title: z.string().min(1),
      description: z.string().min(1),
      prompt: z.string().min(1),
      instructions: z.string().optional(),
      parameters: z.array(recipeParameterSchema).max(33),
      response: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(yaml(recipeText));
  const supplied = new Set([...Object.keys(job.inputs), 'baseline']);
  const declared = new Set(recipe.parameters.map((parameter) => parameter.key));
  if (
    declared.size !== recipe.parameters.length ||
    [...supplied].some((key) => !declared.has(key))
  )
    throw new Error('Recipe must declare all fixed inputs and baseline');
  const parameters = recipe.parameters.filter(
    (parameter) => !supplied.has(parameter.key),
  );
  if (
    job.triggers.schedule &&
    parameters.some(
      (parameter) =>
        parameter.requirement === 'required' && parameter.default === undefined,
    )
  )
    throw new Error('Scheduled recipe parameters need defaults');
  return jobDefinitionSchema.parse({
    repository: repo,
    revision,
    name: jobName,
    job,
    recipeText,
    parameters,
    digest: jobDigest([jobText, recipeText]),
  });
}
export function authorizeJob(
  definition: JobDefinition,
  profile: JobProfile | undefined,
  principal: string,
): JobProfile {
  if (
    !profile ||
    profile.name !== definition.job.execution.profile ||
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

/** Goose declares variable parameters; the manifest owns fixed execution scope. */
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
  return Object.fromEntries(
    definition.parameters.map((parameter) => {
      const value = values[parameter.key] ?? parameter.default;
      if (value === undefined && parameter.requirement === 'required')
        throw new Error(`Missing recipe parameter: ${parameter.key}`);
      return [parameter.key, value ?? ''];
    }),
  );
}
