import { jobSecretSnapshotSchema } from '@agent-lcars/work';
import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import {
  jobDefinitionSchema,
  jobDigest,
  jobInputsSchema,
  jobProfileNameSchema,
  jobProfileSchema,
} from './repository-job-definition';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const jobArtifactSchema = z.strictObject({
  digest: hash,
  successful: z.boolean(),
  artifacts: z.record(z.string(), z.unknown()),
  baseline: z.unknown(),
});
export type JobArtifact = z.infer<typeof jobArtifactSchema>;
export const catalogJobSchema = z.strictObject({
  id: hash,
  repository: z.string(),
  name: z.string(),
  definition: jobDefinitionSchema.optional(),
  error: z.string().max(2048).optional(),
  refreshedAt: z.iso.datetime(),
  enabled: z.boolean(),
  enabledBy: z.string().optional(),
  activationFloor: z.iso.datetime().optional(),
  /** The operator's sticky per-job veto: a principal while an explicit
   * disable stands, null once an explicit enable clears it. Records written
   * before automatic activation omit it (see `operatorVeto`). */
  vetoedBy: z.string().nullable().optional(),
  active: hash.optional(),
  latest: hash.optional(),
  baseline: z.strictObject({ occurrence: hash, comparison: hash }).optional(),
});
export type CatalogJob = z.infer<typeof catalogJobSchema>;
// Storage compatibility only. New configuration still uses jobProfileSchema;
// runtime authorization explicitly refuses legacy credential delivery.
const storedJobProfileSchema = z.union([
  jobProfileSchema,
  jobProfileSchema
    .safeExtend({
      credentials: z.strictObject({ github: jobProfileNameSchema }),
    })
    .refine(
      (profile) => !profile.credentialSet && !profile.crossRepo,
      'Legacy credentials cannot be combined with current credential sets or crossRepo',
    ),
  // Retired Homelab Goose environment overlay selector. Occurrences admitted
  // while it existed stay readable; job credentials now come from credential
  // sets, and the runner no longer reads overlay files.
  jobProfileSchema.safeExtend({ environment: jobProfileNameSchema }),
]);
const sourceRefreshSchema = z.strictObject({
  repository: z.string(),
  refreshedAt: z.iso.datetime(),
});
export const jobOccurrenceSchema = z.strictObject({
  id: hash,
  jobId: hash,
  workId: z.string(),
  requestDigest: hash,
  createdAt: z.iso.datetime(),
  principal: z.string(),
  trigger: z.enum(['manual', 'schedule']),
  skipped: z.boolean(),
  definition: jobDefinitionSchema,
  profile: storedJobProfileSchema,
  secretSnapshot: jobSecretSnapshotSchema.optional(),
  comparison: hash,
  parameters: jobInputsSchema.default({}),
  baselineOccurrence: hash.optional(),
  artifact: jobArtifactSchema.optional(),
  reconciledAt: z.iso.datetime().optional(),
  successful: z.boolean().optional(),
  admissionFailure: z.literal('legacy-credentials').optional(),
});
export type JobOccurrence = z.infer<typeof jobOccurrenceSchema>;
// Artifact contents are opaque JSON, not Firestore field values. This preserves
// nested arrays and prevents arbitrary result maps from consuming index entries.
const persistedOccurrenceSchema = jobOccurrenceSchema
  .omit({ artifact: true })
  .extend({
    artifactJson: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= 384 * 1024)
      .optional(),
  });
function decodeOccurrence(value: unknown): JobOccurrence {
  const { artifactJson, ...occurrence } =
    persistedOccurrenceSchema.parse(value);
  return jobOccurrenceSchema.parse({
    ...occurrence,
    ...(artifactJson === undefined
      ? {}
      : { artifact: JSON.parse(artifactJson) }),
  });
}
function encodeOccurrence(value: JobOccurrence): unknown {
  const { artifact, ...occurrence } = jobOccurrenceSchema.parse(value);
  return persistedOccurrenceSchema.parse({
    ...occurrence,
    ...(artifact === undefined
      ? {}
      : { artifactJson: JSON.stringify(artifact) }),
  });
}
export interface JobStore {
  list(): Promise<CatalogJob[]>;
  /** Last catalog refresh attempt per repository, including repositories
   * that define no jobs, so refresh fairness survives across instances. */
  sourceRefreshes(): Promise<Map<string, string>>;
  recordSourceRefresh(repository: string, refreshedAt: string): Promise<void>;
  readOccurrence(id: string): Promise<JobOccurrence | undefined>;
  history(jobId: string): Promise<JobOccurrence[]>;
  mutate(
    jobId: string,
    occurrenceId: string | undefined,
    change: (
      job: CatalogJob | undefined,
      occurrence: JobOccurrence | undefined,
    ) =>
      | { job?: CatalogJob; occurrence?: JobOccurrence }
      | Promise<{ job?: CatalogJob; occurrence?: JobOccurrence }>,
  ): Promise<{ job?: CatalogJob; occurrence?: JobOccurrence }>;
}

/** Admission's active pointer and its immutable occurrence commit together. */
export class FirestoreJobStore implements JobStore {
  constructor(private readonly database: Firestore) {}
  async list(): Promise<CatalogJob[]> {
    const snapshot = await this.database
      .collection('orchestrator-jobs')
      .limit(501)
      .get();
    if (snapshot.size > 500)
      throw new Error('Job catalog exceeds supported bound');
    return snapshot.docs.map((doc) => catalogJobSchema.parse(doc.data()));
  }
  async sourceRefreshes(): Promise<Map<string, string>> {
    const snapshot = await this.database
      .collection('orchestrator-job-sources')
      .limit(501)
      .get();
    if (snapshot.size > 500)
      throw new Error('Job sources exceed supported bound');
    return new Map(
      snapshot.docs.map((doc) => {
        const source = sourceRefreshSchema.parse(doc.data());
        return [source.repository, source.refreshedAt];
      }),
    );
  }
  async recordSourceRefresh(
    repository: string,
    refreshedAt: string,
  ): Promise<void> {
    await this.database
      .collection('orchestrator-job-sources')
      .doc(jobDigest(['source', repository]))
      .set(sourceRefreshSchema.parse({ repository, refreshedAt }));
  }
  async readOccurrence(id: string): Promise<JobOccurrence | undefined> {
    const snapshot = await this.database
      .collection('orchestrator-job-occurrences')
      .doc(hash.parse(id))
      .get();
    return snapshot.exists ? decodeOccurrence(snapshot.data()) : undefined;
  }
  async history(jobId: string): Promise<JobOccurrence[]> {
    const snapshot = await this.database
      .collection('orchestrator-job-occurrences')
      .where('jobId', '==', hash.parse(jobId))
      .limit(100)
      .get();
    return snapshot.docs.map((doc) => decodeOccurrence(doc.data()));
  }
  async mutate(
    jobId: string,
    occurrenceId: string | undefined,
    change: Parameters<JobStore['mutate']>[2],
  ): ReturnType<JobStore['mutate']> {
    const jobRef = this.database
      .collection('orchestrator-jobs')
      .doc(hash.parse(jobId));
    const occurrenceRef =
      occurrenceId === undefined
        ? undefined
        : this.database
            .collection('orchestrator-job-occurrences')
            .doc(hash.parse(occurrenceId));
    return this.database.runTransaction(async (transaction) => {
      const job = await transaction.get(jobRef);
      const occurrence =
        occurrenceRef === undefined
          ? undefined
          : await transaction.get(occurrenceRef);
      const result = await change(
        job.exists ? catalogJobSchema.parse(job.data()) : undefined,
        occurrence?.exists ? decodeOccurrence(occurrence.data()) : undefined,
      );
      // Strip undefined optional properties; Firestore cannot store them.
      if (result.job)
        transaction.set(
          jobRef,
          JSON.parse(JSON.stringify(catalogJobSchema.parse(result.job))),
        );
      if (result.occurrence && occurrenceRef)
        transaction.set(
          occurrenceRef,
          JSON.parse(JSON.stringify(encodeOccurrence(result.occurrence))),
        );
      return result;
    });
  }
}
