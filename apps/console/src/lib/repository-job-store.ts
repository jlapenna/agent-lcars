import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import {
  jobDefinitionSchema,
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
  active: hash.optional(),
  latest: hash.optional(),
  baseline: z.strictObject({ occurrence: hash, comparison: hash }).optional(),
});
export type CatalogJob = z.infer<typeof catalogJobSchema>;
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
  profile: jobProfileSchema,
  comparison: hash,
  baselineOccurrence: hash.optional(),
  artifact: jobArtifactSchema.optional(),
  reconciledAt: z.iso.datetime().optional(),
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
  readOccurrence(id: string): Promise<JobOccurrence | undefined>;
  history(jobId: string): Promise<JobOccurrence[]>;
  mutate(
    jobId: string,
    occurrenceId: string | undefined,
    change: (
      job: CatalogJob | undefined,
      occurrence: JobOccurrence | undefined,
    ) => {
      job?: CatalogJob;
      occurrence?: JobOccurrence;
    },
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
      const result = change(
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
