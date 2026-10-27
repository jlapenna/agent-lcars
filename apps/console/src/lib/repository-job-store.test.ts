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
  },
);
