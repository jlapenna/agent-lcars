import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import {
  jobDefinitionSchema,
  jobProfileSchema,
} from './repository-job-definition';
import { validateJobResult } from './repository-job-result';
import { FirestoreJobStore } from './repository-job-store';

const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
if (process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' && !emulatorHost)
  throw new Error('Firestore emulator required');
describe.skipIf(!emulatorHost)(
  'repository job Firestore transaction boundary',
  () => {
    it('round-trips nested JSON arrays through persistence and transaction reads', async () => {
      const database = new Firestore({
        projectId: `demo-json-${Date.now()}`,
        host: emulatorHost,
        ssl: false,
      });
      const store = new FirestoreJobStore(database);
      const id = 'd'.repeat(64);
      const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
      const definition = jobDefinitionSchema.parse({
        repository: 'octo/repo',
        revision: 'a'.repeat(40),
        name: 'audit',
        digest: id,
        recipeText: 'fixture',
        job: {
          version: 1,
          description: 'JSON fixture',
          triggers: { manual: true },
          execution: {
            recipe: './recipe.yaml',
            profile: 'audit',
            timeout: '10m',
            maxAttempts: 1,
            resources: { requests: allocation, limits: allocation },
          },
          inputs: {},
          concurrency: { maxRuns: 1, overlap: 'skip' },
          state: { previousSuccessfulResult: true },
          result: {
            contract: 'json-v1',
            requiredArtifacts: ['report.md', 'result.json'],
          },
        },
      });
      const profile = jobProfileSchema.parse({
        name: 'audit',
        repositories: ['octo/repo'],
        principals: ['operator'],
        allocation,
        inputSets: [{}],
      });
      const artifact = validateJobResult(definition, {
        report: 'Nested JSON',
        complete: true,
        data: { matrix: [[1, 2]] },
      });
      try {
        await store.mutate(id, id, () => ({
          occurrence: {
            id,
            jobId: id,
            workId: 'fixture',
            requestDigest: id,
            createdAt: '2026-10-27T00:00:00.000Z',
            principal: 'operator',
            trigger: 'manual',
            skipped: false,
            definition,
            profile,
            comparison: id,
            artifact,
          },
        }));
        expect((await store.readOccurrence(id))?.artifact).toEqual(artifact);
        expect((await store.history(id))[0]?.artifact).toEqual(artifact);
        await store.mutate(id, id, (_job, occurrence) => {
          expect(occurrence?.artifact).toEqual(artifact);
          return { occurrence };
        });
      } finally {
        await database.terminate();
      }
    });
    it('stores multi-MiB artifacts and shared definitions out of line, and still reads inline occurrences', async () => {
      const database = new Firestore({
        projectId: `demo-layout-${Date.now()}`,
        host: emulatorHost,
        ssl: false,
      });
      const store = new FirestoreJobStore(database);
      const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
      const definition = jobDefinitionSchema.parse({
        repository: 'octo/repo',
        revision: 'a'.repeat(40),
        name: 'audit',
        digest: 'd'.repeat(64),
        recipeText: 'r'.repeat(300 * 1024),
        job: {
          version: 1,
          description: 'Layout fixture',
          triggers: { manual: true },
          execution: {
            recipe: './recipe.yaml',
            profile: 'audit',
            timeout: '10m',
            maxAttempts: 1,
            resources: { requests: allocation, limits: allocation },
          },
          inputs: {},
          concurrency: { maxRuns: 1, overlap: 'skip' },
          state: { previousSuccessfulResult: true },
          result: {
            contract: 'json-v1',
            requiredArtifacts: ['report.md', 'result.json'],
          },
        },
      });
      const profile = jobProfileSchema.parse({
        name: 'audit',
        repositories: ['octo/repo'],
        principals: ['operator'],
        allocation,
        inputSets: [{}],
      });
      // ~3 MiB of data, staged twice (result.json and baseline).
      const artifact = validateJobResult(definition, {
        report: 'Large result',
        complete: true,
        data: {
          rows: Array.from({ length: 3 }, () => 'x'.repeat(1024 * 1024)),
        },
      });
      const occurrence = (id: string) => ({
        id,
        jobId: 'b'.repeat(64),
        workId: 'fixture',
        requestDigest: id,
        createdAt: '2026-10-27T00:00:00.000Z',
        principal: 'operator',
        trigger: 'manual' as const,
        skipped: false,
        definition,
        profile,
        comparison: id,
        parameters: { target: 'p'.repeat(400 * 1024) },
      });
      try {
        const first = { ...occurrence('c'.repeat(64)), artifact };
        await store.mutate(first.jobId, first.id, () => ({
          occurrence: first,
        }));
        await store.mutate(first.jobId, 'e'.repeat(64), () => ({
          occurrence: occurrence('e'.repeat(64)),
        }));
        expect(await store.readOccurrence(first.id)).toEqual(first);
        expect(
          (await database.collection('orchestrator-job-definitions').get())
            .size,
        ).toBe(1);
        const stored = (
          await database
            .collection('orchestrator-job-occurrences')
            .doc(first.id)
            .get()
        ).data()!;
        expect(stored['definition']).toBeUndefined();
        expect(stored['artifactRef']['chunks']).toBeGreaterThan(1);
        // An occurrence written before the layout still reads.
        const legacy = { ...occurrence('f'.repeat(64)), definition };
        const small = validateJobResult(definition, {
          report: 'Legacy',
          complete: true,
          data: { matrix: [[1, 2]] },
        });
        await database
          .collection('orchestrator-job-occurrences')
          .doc(legacy.id)
          .set({
            ...JSON.parse(JSON.stringify(legacy)),
            artifactJson: JSON.stringify(small),
          });
        expect(await store.readOccurrence(legacy.id)).toEqual({
          ...legacy,
          artifact: small,
        });
        expect(await store.history(first.jobId)).toHaveLength(3);
      } finally {
        await database.terminate();
      }
    });
    it('serializes concurrent active-pointer changes and survives a client restart', async () => {
      const options = {
        projectId: `demo-jobs-${Date.now()}`,
        host: emulatorHost,
        ssl: false,
      };
      const database = new Firestore(options);
      const store = new FirestoreJobStore(database);
      const id = 'a'.repeat(64);
      try {
        await store.mutate(id, undefined, () => ({
          job: {
            id,
            repository: 'octo/repo',
            name: 'audit',
            refreshedAt: '2026-10-27T00:00:00.000Z',
            enabled: false,
            error: 'old source error',
          },
        }));
        const outcomes = await Promise.all(
          ['b', 'c'].map((value) =>
            store.mutate(id, undefined, (job) => {
              if (job!.active) return {};
              return {
                job: { ...job!, active: value.repeat(64), error: undefined },
              };
            }),
          ),
        );
        expect(outcomes.filter((value) => value.job)).toHaveLength(1);
        const restarted = new Firestore(options);
        try {
          const [job] = await new FirestoreJobStore(restarted).list();
          expect(job?.active).toMatch(/^[bc]{64}$/u);
          expect(job?.error).toBeUndefined();
        } finally {
          await restarted.terminate();
        }
      } finally {
        await database.terminate();
      }
    });
    it('persists a cleared veto and per-repository refresh times', async () => {
      const database = new Firestore({
        projectId: `demo-sources-${Date.now()}`,
        host: emulatorHost,
        ssl: false,
      });
      const store = new FirestoreJobStore(database);
      const id = 'e'.repeat(64);
      try {
        await store.mutate(id, undefined, () => ({
          job: {
            id,
            repository: 'octo/repo',
            name: 'audit',
            refreshedAt: '2026-10-27T00:00:00.000Z',
            enabled: false,
            vetoedBy: null,
          },
        }));
        expect((await store.list())[0]?.vetoedBy).toBeNull();
        await store.recordSourceRefresh(
          'octo/empty',
          '2026-10-27T00:05:00.000Z',
        );
        expect(await store.sourceRefreshes()).toEqual(
          new Map([['octo/empty', '2026-10-27T00:05:00.000Z']]),
        );
      } finally {
        await database.terminate();
      }
    });
  },
);
