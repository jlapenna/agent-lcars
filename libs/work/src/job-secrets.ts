import { z } from 'zod';

export const jobSecretNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const revision = z.number().int().positive().max(1000000);
export const credentialSetReferenceSchema = z.strictObject({
  name: jobSecretNameSchema,
  revision,
});
export const jobSecretRecordSchema = z
  .strictObject({
    name: jobSecretNameSchema,
    kind: z.enum(['github', 'opaque']),
    login: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/u)
      .optional(),
    enabled: z.boolean(),
    promotedVersion: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    validatedAt: z.iso.datetime().optional(),
    lastUsedAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime(),
    updatedBy: z.string().min(1).max(128),
  })
  .refine(
    (record) => (record.kind === 'github') === (record.login !== undefined),
    'GitHub secrets require an expected login; opaque secrets cannot declare one',
  );
export type JobSecretRecord = z.infer<typeof jobSecretRecordSchema>;
const environmentName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
  .refine(
    (key) =>
      !/^(?:PATH|HOME|ENV|SHELL|IFS|TMPDIR|USER|LOGNAME|WORKSPACE|REPOSITORY|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|NODE_OPTIONS|NODE_PATH)$/u.test(
        key,
      ) &&
      !/^(?:LCARS_|AGENT_|GOOSE_|GIT_|GITHUB_|GH_|ACTIONS_|RUNNER_|PROVIDER_|AUTH_|GOOGLE_|GCP_|BASH_|LD_|DYLD_|PYTHON|NPM_|PNPM_)/u.test(
        key,
      ),
    'Reserved runtime environment variable',
  );
const bindings = z
  .record(environmentName, jobSecretNameSchema)
  .refine((value) => Object.keys(value).length <= 16, 'Too many bindings');
export const credentialSetSchema = z
  .strictObject({
    ...credentialSetReferenceSchema.shape,
    github: jobSecretNameSchema.optional(),
    environment: bindings.default({}),
    files: z
      .record(jobSecretNameSchema, jobSecretNameSchema)
      .refine(
        (value) => Object.keys(value).length <= 16,
        'Too many file bindings',
      )
      .default({}),
  })
  .refine(
    (set) =>
      (set.github ? 1 : 0) +
        Object.keys(set.environment).length +
        Object.keys(set.files).length >
        0 &&
      (set.github ? 1 : 0) +
        Object.keys(set.environment).length +
        Object.keys(set.files).length <=
        16,
    'Credential sets must contain between 1 and 16 bindings',
  );
export type CredentialSet = z.infer<typeof credentialSetSchema>;
export const jobCredentialGrantSchema = z.strictObject({
  repository,
  job: jobSecretNameSchema,
  profile: jobSecretNameSchema,
  credentialSet: credentialSetReferenceSchema,
  principals: z.array(z.string().min(1).max(128)).min(1).max(32),
  allowScheduled: z.boolean(),
  enabled: z.boolean(),
});
export type JobCredentialGrant = z.infer<typeof jobCredentialGrantSchema>;
export const jobSecretSnapshotSchema = z.strictObject({
  credentialSet: credentialSetReferenceSchema,
  versions: z.record(jobSecretNameSchema, z.string().regex(/^[1-9][0-9]*$/u)),
});
export type JobSecretSnapshot = z.infer<typeof jobSecretSnapshotSchema>;
export const githubJobSecretSchema = z.strictObject({
  token: z.string().min(1).max(1024).regex(/^\S+$/u),
  expiresAt: z.iso.datetime().nullable(),
});
export const jobSecretValueSchema = z
  .string()
  .min(1)
  .max(16384)
  .refine(
    (value) =>
      !value.includes('\0') && new TextEncoder().encode(value).length <= 16384,
    'Secret must be UTF-8 text without NUL and at most 16 KiB',
  );
export const jobSecretDeliverySchema = z.strictObject({
  environment: z.record(environmentName, jobSecretValueSchema),
  files: z.record(jobSecretNameSchema, jobSecretValueSchema),
});
