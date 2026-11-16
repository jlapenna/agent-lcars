import { createHash } from 'node:crypto';

import { jobSecretSnapshotSchema } from '@agent-lcars/work';
import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import { assertFirestoreDocumentFits } from './firestore-document-size';
import {
  type JobDefinition,
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
   * disable stands, null once an explicit enable clears it. */
  vetoedBy: z.string().nullable().optional(),
  active: hash.optional(),
  latest: hash.optional(),
  baseline: z.strictObject({ occurrence: hash, comparison: hash }).optional(),
});
export type CatalogJob = z.infer<typeof catalogJobSchema>;
// Storage compatibility only: occurrences admitted with the retired Homelab
// Goose environment overlay selector remain readable.
const storedJobProfileSchema = jobProfileSchema.safeExtend({
  environment: jobProfileNameSchema.optional(),
});
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
  /** The provider-limited occurrence this one re-runs under its profile's
   * fallbackProfile. */
  fallbackOf: hash.optional(),
  /** Profiles the earlier attempts of this chain ran under, oldest first. A
   * fallback without it (recorded before chaining) never falls back again. */
  fallbackProfiles: z.array(z.string().min(1).max(128)).max(4).optional(),
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
});
export type JobOccurrence = z.infer<typeof jobOccurrenceSchema>;
// Occurrence documents hold the per-run record only. The pinned definition and
// the staged artifact live out of line, content-addressed, so neither competes
// with the occurrence for Firestore's 1 MiB document limit:
// - `orchestrator-job-definitions/{jobDigest(definition)}` holds one definition
//   shared by every occurrence pinned to it;
// - `orchestrator-job-artifact-chunks/{sha256}.{n}` holds the artifact's JSON as
//   bytes in chunks, verified against the digest on read.
// Both are immutable once written; a write repeated by a transaction retry is
// idempotent, and an aborted admission leaves at most an unreferenced copy.
// Occurrences written before this layout embed `definition` and
// `artifactJson` and still read unchanged.
const DEFINITIONS = 'orchestrator-job-definitions';
const ARTIFACT_CHUNKS = 'orchestrator-job-artifact-chunks';
/** Bytes per artifact chunk, leaving room for the chunk document's name. */
export const ARTIFACT_CHUNK_BYTES = 1000 * 1024;
const artifactRefSchema = z.strictObject({
  sha256: hash,
  bytes: z.number().int().positive(),
  chunks: z.number().int().positive(),
});
const persistedOccurrenceSchema = jobOccurrenceSchema
  .omit({ artifact: true, definition: true })
  .extend({
    definition: jobDefinitionSchema.optional(),
    definitionKey: hash.optional(),
    // Legacy inline artifact JSON (opaque, never Firestore field values).
    artifactJson: z.string().optional(),
    artifactRef: artifactRefSchema.optional(),
  })
  .refine(
    (value) =>
      (value.definition === undefined) !== (value.definitionKey === undefined),
    'Occurrence needs exactly one definition or definitionKey',
  )
  .refine(
    (value) =>
      value.artifactJson === undefined || value.artifactRef === undefined,
    'Occurrence has two artifacts',
  );
type PersistedOccurrence = z.infer<typeof persistedOccurrenceSchema>;
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
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
    // No ceiling: one repository may publish any number of jobs, invalid
    // ones included, and the catalog must stay readable.
    const snapshot = await this.database.collection('orchestrator-jobs').get();
    return snapshot.docs.map((doc) => catalogJobSchema.parse(doc.data()));
  }
  async sourceRefreshes(): Promise<Map<string, string>> {
    const snapshot = await this.database
      .collection('orchestrator-job-sources')
      .get();
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
    return snapshot.exists ? this.decode(snapshot.data()) : undefined;
  }
  async history(jobId: string): Promise<JobOccurrence[]> {
    const snapshot = await this.database
      .collection('orchestrator-job-occurrences')
      .where('jobId', '==', hash.parse(jobId))
      .limit(100)
      .get();
    const definitions = new Map<string, Promise<JobDefinition>>();
    return Promise.all(
      snapshot.docs.map((doc) => this.decode(doc.data(), definitions)),
    );
  }
  /** Resolves out-of-line content; legacy inline fields read as before. */
  private async decode(
    value: unknown,
    definitions = new Map<string, Promise<JobDefinition>>(),
  ): Promise<JobOccurrence> {
    const { definition, definitionKey, artifactJson, artifactRef, ...rest } =
      persistedOccurrenceSchema.parse(value);
    let resolved = definition;
    if (definitionKey !== undefined) {
      let pending = definitions.get(definitionKey);
      if (!pending) {
        pending = this.readDefinition(definitionKey);
        definitions.set(definitionKey, pending);
      }
      resolved = await pending;
    }
    const json =
      artifactRef === undefined
        ? artifactJson
        : await this.readArtifact(artifactRef);
    return jobOccurrenceSchema.parse({
      ...rest,
      definition: resolved,
      ...(json === undefined ? {} : { artifact: JSON.parse(json) }),
    });
  }
  private async readDefinition(key: string): Promise<JobDefinition> {
    const snapshot = await this.database
      .collection(DEFINITIONS)
      .doc(hash.parse(key))
      .get();
    const { json } = z
      .strictObject({ json: z.string() })
      .parse(snapshot.data());
    const definition = jobDefinitionSchema.parse(JSON.parse(json));
    if (jobDigest(definition) !== key)
      throw new Error('Stored job definition does not match its key');
    return definition;
  }
  private async readArtifact(
    ref: z.infer<typeof artifactRefSchema>,
  ): Promise<string> {
    const snapshots = await this.database.getAll(
      ...Array.from({ length: ref.chunks }, (_, index) =>
        this.database.collection(ARTIFACT_CHUNKS).doc(`${ref.sha256}.${index}`),
      ),
    );
    const data = Buffer.concat(
      snapshots.map((snapshot) => {
        const chunk: unknown = snapshot.data()?.['data'];
        if (!ArrayBuffer.isView(chunk))
          throw new Error('Stored job artifact chunk is missing');
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }),
    );
    if (data.byteLength !== ref.bytes || sha256(data) !== ref.sha256)
      throw new Error('Stored job artifact does not match its digest');
    return data.toString('utf8');
  }
  /**
   * Writes the occurrence's out-of-line content (unless the stored version
   * already references it) and returns the document that references it.
   */
  private async encode(
    value: JobOccurrence,
    previous: PersistedOccurrence | undefined,
  ): Promise<PersistedOccurrence> {
    const { artifact, definition, ...occurrence } =
      jobOccurrenceSchema.parse(value);
    const definitionKey = jobDigest(definition);
    if (previous?.definitionKey !== definitionKey) {
      const ref = this.database.collection(DEFINITIONS).doc(definitionKey);
      const data = { json: JSON.stringify(definition) };
      assertFirestoreDocumentFits(ref.path, data, 'Job definition');
      await ref.set(data);
    }
    let artifactRef: PersistedOccurrence['artifactRef'];
    if (artifact !== undefined) {
      const data = Buffer.from(JSON.stringify(artifact), 'utf8');
      artifactRef = {
        sha256: sha256(data),
        bytes: data.byteLength,
        chunks: Math.max(1, Math.ceil(data.byteLength / ARTIFACT_CHUNK_BYTES)),
      };
      if (previous?.artifactRef?.sha256 !== artifactRef.sha256) {
        // Commit requests are limited to 10 MiB, so write a few chunks each.
        for (let first = 0; first < artifactRef.chunks; first += 8) {
          const batch = this.database.batch();
          for (
            let index = first;
            index < Math.min(first + 8, artifactRef.chunks);
            index++
          )
            batch.set(
              this.database
                .collection(ARTIFACT_CHUNKS)
                .doc(`${artifactRef.sha256}.${index}`),
              {
                data: data.subarray(
                  index * ARTIFACT_CHUNK_BYTES,
                  (index + 1) * ARTIFACT_CHUNK_BYTES,
                ),
              },
            );
          await batch.commit();
        }
      }
    }
    return persistedOccurrenceSchema.parse({
      ...occurrence,
      definitionKey,
      ...(artifactRef === undefined ? {} : { artifactRef }),
    });
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
      const previous = occurrence?.exists
        ? persistedOccurrenceSchema.parse(occurrence.data())
        : undefined;
      const result = await change(
        job.exists ? catalogJobSchema.parse(job.data()) : undefined,
        occurrence?.exists ? await this.decode(occurrence.data()) : undefined,
      );
      // Strip undefined optional properties; Firestore cannot store them.
      // Size checks name the refused record instead of a bare RPC error.
      let jobData: object | undefined;
      if (result.job) {
        jobData = JSON.parse(
          JSON.stringify(catalogJobSchema.parse(result.job)),
        ) as object;
        assertFirestoreDocumentFits(jobRef.path, jobData, 'Job catalog entry');
      }
      let occurrenceData: object | undefined;
      if (result.occurrence && occurrenceRef) {
        occurrenceData = JSON.parse(
          JSON.stringify(await this.encode(result.occurrence, previous)),
        ) as object;
        assertFirestoreDocumentFits(
          occurrenceRef.path,
          occurrenceData,
          'Job occurrence',
        );
      }
      if (jobData) transaction.set(jobRef, jobData);
      if (occurrenceData && occurrenceRef)
        transaction.set(occurrenceRef, occurrenceData);
      return result;
    });
  }
}
