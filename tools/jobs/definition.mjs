import { createHash } from 'node:crypto';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import { latestDueSlot, parseCron } from '../../libs/work/src/cron.ts';

export const MAX_DOCUMENT_BYTES = 64 * 1024;
const quantity = z.string().regex(/^[1-9][0-9]*Gi$/u);
const allocation = z.strictObject({
  cpu: z.number().positive().max(2),
  memory: quantity.refine((v) => parseInt(v, 10) <= 6),
  storage: quantity.refine((v) => parseInt(v, 10) <= 40),
});
const token = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const jobSchema = z.strictObject({
  version: z.literal(1),
  description: z.string().min(1).max(1024),
  triggers: z.strictObject({
    manual: z.boolean(),
    schedule: z
      .strictObject({
        cron: z
          .string()
          .max(64)
          .refine((v) => {
            try {
              parseCron(v);
              return true;
            } catch {
              return false;
            }
          }),
        timezone: z
          .string()
          .max(128)
          .refine((v) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: v });
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
    profile: token,
    timeout: z
      .string()
      .regex(/^[1-9][0-9]*m$/u)
      .refine((v) => parseInt(v, 10) <= 30),
    maxAttempts: z.literal(1),
    resources: z
      .strictObject({ requests: allocation, limits: allocation })
      .refine(
        ({ requests, limits }) =>
          ['cpu', 'memory', 'storage'].every(
            (key) => requests[key] === limits[key],
          ),
        'requests must equal limits',
      ),
  }),
  inputs: z.strictObject({
    subnet: z
      .string()
      .regex(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u)
      .refine((value) =>
        value
          .split('/')[0]
          .split('.')
          .every((octet) => Number(octet) <= 255),
      ),
    findingsRepository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
    mode: z.literal('report'),
  }),
  concurrency: z.strictObject({
    maxRuns: z.literal(1),
    overlap: z.literal('skip'),
  }),
  state: z.strictObject({ previousSuccessfulResult: z.boolean() }),
  result: z.strictObject({
    contract: z.literal('security-audit-v1'),
    requiredArtifacts: z.tuple([
      z.literal('report.md'),
      z.literal('findings.json'),
      z.literal('coverage.json'),
    ]),
  }),
});

export function decodeYaml(text) {
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
    throw new Error('document exceeds 64 KiB');
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length)
    throw new Error(doc.errors.map((e) => e.message).join('; '));
  return doc.toJS({ maxAliasCount: 0 });
}

export function definition({
  repository,
  revision,
  name,
  jobText,
  recipeText,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error('invalid repository');
  if (!/^[a-f0-9]{40}$/u.test(revision))
    throw new Error('source must be an exact commit');
  token.parse(name);
  const job = jobSchema.parse(decodeYaml(jobText));
  const recipe = decodeYaml(recipeText);
  z.object({
    version: z.literal('1.0.0'),
    title: z.string().min(1),
    description: z.string().min(1),
  }).parse(recipe);
  if (!recipe || typeof recipe.prompt !== 'string' || !recipe.prompt.trim()) {
    throw new Error('headless recipe needs a prompt');
  }
  // v1 deliberately has one retry owner and one execution unit.
  if (
    recipe.retry ||
    recipe.sub_recipes ||
    recipe.subRecipes ||
    recipe.extensions ||
    recipe.settings
  ) {
    throw new Error(
      'recipe retries, subrecipes, extensions and settings are owned by the execution profile',
    );
  }
  const parameters = recipe.parameters ?? [];
  if (!Array.isArray(parameters))
    throw new Error('recipe parameters must be an array');
  const keys = new Set();
  const supplied = new Set([...Object.keys(job.inputs), 'baseline']);
  for (const parameter of parameters) {
    z.object({
      key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u),
      description: z.string().min(1),
      input_type: z.literal('string'),
      requirement: z.enum(['required', 'optional']),
      default: z.string().optional(),
    }).parse(parameter);
    if (keys.has(parameter.key))
      throw new Error(`duplicate parameter: ${parameter.key}`);
    keys.add(parameter.key);
    if (parameter.requirement === 'optional' && parameter.default === undefined)
      throw new Error('optional parameters require defaults');
    if (parameter.requirement === 'required' && !supplied.has(parameter.key)) {
      throw new Error(`missing required parameter: ${parameter.key}`);
    }
  }
  const declared = new Set(parameters.map((p) => p.key));
  for (const key of Object.keys(job.inputs)) {
    if (!declared.has(key)) throw new Error(`undeclared parameter: ${key}`);
  }
  if (!declared.has('baseline'))
    throw new Error('recipe must declare baseline parameter');
  const digest = createHash('sha256')
    .update(jobText)
    .update('\0')
    .update(recipeText)
    .digest('hex');
  return {
    id: `${repository}:${name}`,
    repository,
    revision,
    name,
    digest,
    job,
    recipeText,
  };
}

// Evaluate one explicit minute, reusing LCARS's AND-based cron grammar. No
// backfill on startup: missed ticks are not silently converted into new scans.
export function dueAt(def, at) {
  const schedule = def.job.triggers.schedule;
  if (!schedule) return false;
  if (!Number.isFinite(at.getTime())) throw new Error('invalid tick time');
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
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`,
  );
  return Boolean(
    latestDueSlot(
      parseCron(schedule.cron),
      local,
      new Date(local.getTime() - 60_000),
    ),
  );
}

export function admitProfile(def, profile) {
  if (!profile || profile.name !== def.job.execution.profile)
    throw new Error('profile not granted');
  const requested = def.job.execution.resources.requests;
  allocation.parse(profile.capacity);
  if (
    requested.cpu > profile.capacity.cpu ||
    parseInt(requested.memory, 10) > parseInt(profile.capacity.memory, 10) ||
    parseInt(requested.storage, 10) > parseInt(profile.capacity.storage, 10)
  ) {
    throw new Error('job exceeds selected lane capacity');
  }
  if (!profile.repositories.includes(def.repository))
    throw new Error('repository not granted');
  if (!profile.subnets?.includes(def.job.inputs.subnet))
    throw new Error('network scope not granted');
  if (
    !profile.findingsRepositories?.includes(def.job.inputs.findingsRepository)
  )
    throw new Error('findings repository not granted');
}
