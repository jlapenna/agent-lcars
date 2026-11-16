import {
  JOB_SECRET_VALUE_MAX_BYTES,
  jobSecretValueSchema,
  REPOSITORY_JOB_PARAMETERS_MAX_BYTES,
  REPOSITORY_JOB_REQUEST_MAX_BYTES,
  REPOSITORY_JOB_RESULT_MAX_BYTES,
} from '@agent-lcars/work';
import type { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  FIRESTORE_DOCUMENT_MAX_BYTES,
  firestoreDocumentBytes,
} from './firestore-document-size';
import {
  jobProfileSchema,
  parseJobDefinition,
  resolveJobParameters,
} from './repository-job-definition';
import { fileParameterRecipe } from './repository-job-recipe';
import { validateJobResult } from './repository-job-result';
import { FirestoreJobStore, type JobOccurrence } from './repository-job-store';

const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
function manifest(overrides: Record<string, unknown> = {}) {
  return stringify({
    version: 1,
    description: 'Audit',
    triggers: { manual: true },
    execution: {
      recipe: './recipe.yaml',
      profile: 'audit',
      timeout: '10m',
      maxAttempts: 1,
      resources: { requests: { ...allocation }, limits: { ...allocation } },
    },
    inputs: {},
    concurrency: { maxRuns: 1, overlap: 'skip' },
    state: { previousSuccessfulResult: true },
    result: {
      contract: 'json-v1',
      requiredArtifacts: ['report.md', 'result.json'],
    },
    ...overrides,
  });
}
function recipe(variables: string[] = ['target']) {
  return stringify({
    version: '1.0.0',
    title: 'Audit',
    description: 'Audit',
    prompt: `Report ${[...variables, 'baseline'].map((key) => `{{ ${key} }}`).join(' ')}`,
    parameters: [...variables, 'baseline'].map((key) => ({
      key,
      description: key,
      input_type: 'string',
      requirement: 'required',
    })),
  });
}
const parseDefinition = (jobText = manifest(), recipeText = recipe()) =>
  parseJobDefinition('octo/repo', 'a'.repeat(40), 'audit', jobText, recipeText);

describe('repository job definition limits', () => {
  it('accepts storage up to the 40 GiB per-Job k3s ceiling and no further', () => {
    const at = (storage: string) =>
      manifest({
        execution: {
          recipe: './recipe.yaml',
          profile: 'audit',
          timeout: '10m',
          maxAttempts: 1,
          resources: {
            requests: { ...allocation, storage },
            limits: { ...allocation, storage },
          },
        },
      });
    expect(
      parseDefinition(at('40Gi')).job.execution.resources.limits.storage,
    ).toBe('40Gi');
    expect(() => parseDefinition(at('41Gi'))).toThrow();
    expect(() =>
      parseDefinition(
        manifest({
          execution: {
            recipe: './recipe.yaml',
            profile: 'audit',
            timeout: '10m',
            maxAttempts: 1,
            resources: {
              requests: { ...allocation, memory: '7Gi' },
              limits: { ...allocation, memory: '7Gi' },
            },
          },
        }),
      ),
    ).toThrow();
  });

  it('accepts long descriptions and defaults without character caps', () => {
    const long = 'd'.repeat(20_000);
    const text = parse(recipe()) as { parameters: Record<string, unknown>[] };
    text.parameters[0] = {
      ...text.parameters[0],
      requirement: 'optional',
      default: long,
    };
    const definition = parseDefinition(
      manifest({ description: long }),
      stringify(text),
    );
    expect(definition.job.description).toBe(long);
    expect(definition.parameters[0]?.default).toBe(long);
  });

  it('bounds definitions by the stored JSON form, not a fixed file size', () => {
    // Far above the former 64 KiB file cap.
    const large = recipe() + `# ${'c'.repeat(300 * 1024)}\n`;
    expect(parseDefinition(manifest(), large).recipeText).toBe(large);
    // Fits as Firestore fields, but each newline doubles in stored JSON.
    expect(() =>
      parseDefinition(manifest(), recipe() + '\n'.repeat(700 * 1024)),
    ).toThrow(/1 MiB document limit/u);
  });

  it('mirrors Goose: 32 declared parameters load and 33 do not', () => {
    const keys = (count: number) =>
      Array.from({ length: count }, (_, index) => `p${index}`);
    expect(
      parseDefinition(manifest(), recipe(keys(31))).parameters,
    ).toHaveLength(31);
    expect(() => parseDefinition(manifest(), recipe(keys(32)))).toThrow();
  });

  it('bounds parameter values by stored bytes, not count or length', () => {
    const definition = parseDefinition();
    // Far above the former 2,048-character value cap and 16 KiB request.
    const target = 'x'.repeat(200 * 1024);
    expect(resolveJobParameters(definition, { target })).toEqual({ target });
    expect(() =>
      resolveJobParameters(definition, {
        target: 'x'.repeat(REPOSITORY_JOB_PARAMETERS_MAX_BYTES),
      }),
    ).toThrow(/Parameters exceed/u);
    // A request carrying a maximum parameter map fits the request bound.
    const body = JSON.stringify({
      repository: 'octo/repo',
      name: 'audit',
      requestId: 'r'.repeat(256),
      parameters: {
        target: 'x'.repeat(REPOSITORY_JOB_PARAMETERS_MAX_BYTES - 20),
      },
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      REPOSITORY_JOB_REQUEST_MAX_BYTES,
    );
  });

  it('accepts profiles with more than 100 input sets', () => {
    const profile = jobProfileSchema.parse({
      name: 'audit',
      repositories: ['octo/repo'],
      principals: ['user:operator'],
      allocation,
      inputSets: Array.from({ length: 150 }, (_, index) => ({
        mode: `m${index}`,
      })),
    });
    expect(profile.inputSets).toHaveLength(150);
  });

  it('keeps a baseline above the former 48 KiB cap', () => {
    const definition = parseDefinition();
    const data = { findings: 'f'.repeat(200 * 1024) };
    const artifact = validateJobResult(definition, {
      report: 'Large baseline',
      complete: true,
      data,
    });
    expect(artifact.baseline).toEqual(data);
  });
});

describe('Goose file-parameter recipe', () => {
  it('changes only the declarations and keeps template text byte-for-byte', () => {
    const original = [
      'version: 1.0.0',
      'title: t',
      'description: d',
      `prompt: "Target {{ target }} {% if depth == '3' %}deep{% endif %} {{ baseline }}"`,
      'parameters:',
      '  - key: target',
      '    description: T',
      '    input_type: string',
      '    requirement: optional',
      '    default: |',
      '      multi',
      '      line',
      '  - {key: depth, description: D, input_type: "string", requirement: optional, default: "3"}',
      '  - key: baseline # previous result',
      '    description: B',
      '    input_type: string',
      '    requirement: required',
      '',
    ].join('\n');
    expect(fileParameterRecipe(original)).toBe(
      [
        'version: 1.0.0',
        'title: t',
        'description: d',
        `prompt: "Target {{ target }} {% if depth == '3' %}deep{% endif %} {{ baseline }}"`,
        'parameters:',
        '  - key: target',
        '    description: T',
        '    input_type: file',
        '    requirement: required',
        '  - {key: depth, description: D, input_type: file, requirement: required, }',
        '  - key: baseline # previous result',
        '    description: B',
        '    input_type: file',
        '    requirement: required',
        '',
      ].join('\n'),
    );
  });

  it('rewrites a default that opens its list item', () => {
    const original = [
      'prompt: "{{ a }}"',
      'parameters:',
      '  - default: |',
      '      block',
      '    key: a',
      '    description: A',
      '    input_type: string',
      '    requirement: optional',
      '',
    ].join('\n');
    expect(fileParameterRecipe(original)).toBe(
      [
        'prompt: "{{ a }}"',
        'parameters:',
        '  - key: a',
        '    description: A',
        '    input_type: file',
        '    requirement: required',
        '',
      ].join('\n'),
    );
  });

  it('keeps a fixed input referenced only by another default in use', () => {
    // Goose refuses a declared parameter no template references, so the
    // default's `{{ mode }}` must survive the default's removal.
    const recipeText = [
      'version: 1.0.0',
      'title: t',
      'description: d',
      'prompt: "Target {{ target }} with {{ baseline }}"',
      'parameters:',
      '  - key: mode',
      '    description: Fixed mode',
      '    input_type: string',
      '    requirement: required',
      '  - key: target',
      '    description: Target',
      '    input_type: string',
      '    requirement: optional',
      "    default: '{{ mode }}'",
      '  - key: baseline',
      '    description: B',
      '    input_type: string',
      '    requirement: required',
      '',
    ].join('\n');
    const rewritten = fileParameterRecipe(recipeText);
    expect(rewritten).toContain('# {% if false %}{{ mode }}{% endif %}\n');
    expect(rewritten).not.toContain('default:');
    const definition = parseDefinition(
      manifest({ inputs: { mode: 'report' } }),
      recipeText,
    );
    expect(resolveJobParameters(definition, { target: 'override' })).toEqual({
      target: 'override',
    });
  });

  it('refuses at admission a default whose template statements it cannot keep', () => {
    const recipeText = [
      'prompt: "{{ target }}"',
      'parameters:',
      '  - key: target',
      '    description: T',
      '    input_type: string',
      '    requirement: optional',
      "    default: '{% if true %}x{% endif %}'",
      '',
    ].join('\n');
    expect(() => fileParameterRecipe(recipeText)).toThrow(
      /template statements/u,
    );
  });

  it('is validated when the catalog parses a definition', () => {
    expect(() => parseDefinition()).not.toThrow();
    expect(fileParameterRecipe(parseDefinition().recipeText)).toContain(
      'input_type: file',
    );
  });
});

describe('Firestore document size', () => {
  it("matches Firestore's documented example", () => {
    // https://firebase.google.com/docs/firestore/storage-size: 147 bytes.
    expect(
      firestoreDocumentBytes('users/jeff/tasks/my_task_id', {
        type: 'Personal',
        done: false,
        priority: 1,
        description: 'Learn Cloud Firestore',
      }),
    ).toBe(147);
  });

  /** Enough of Firestore for FirestoreJobStore, enforcing the 1 MiB limit. */
  function memoryDatabase() {
    const rows = new Map<string, Record<string, unknown>>();
    const write = (path: string, data: Record<string, unknown>) => {
      // The real service refuses an oversized document the same way.
      expect(firestoreDocumentBytes(path, data)).toBeLessThanOrEqual(
        FIRESTORE_DOCUMENT_MAX_BYTES,
      );
      rows.set(path, structuredClone(data));
    };
    const snapshot = (path: string) => ({
      exists: rows.has(path),
      data: () =>
        rows.has(path) ? structuredClone(rows.get(path)) : undefined,
    });
    const doc = (collection: string, id: string) => {
      const path = `${collection}/${id}`;
      return {
        path,
        get: async () => snapshot(path),
        set: async (data: Record<string, unknown>) => write(path, data),
        create: async (data: Record<string, unknown>) => {
          if (rows.has(path))
            throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
          write(path, data);
        },
      };
    };
    const database = {
      collection: (collection: string) => ({
        doc: (id: string) => doc(collection, id),
      }),
      getAll: async (...refs: { path: string }[]) =>
        refs.map((ref) => snapshot(ref.path)),
      batch: () => {
        const pending: [string, Record<string, unknown>][] = [];
        return {
          set: (ref: { path: string }, data: Record<string, unknown>) =>
            pending.push([ref.path, data]),
          commit: async () => {
            for (const [path, data] of pending) write(path, data);
          },
        };
      },
      runTransaction: async (
        run: (transaction: unknown) => Promise<unknown>,
      ) => {
        const pending: [string, Record<string, unknown>][] = [];
        const result = await run({
          get: async (ref: { path: string }) => snapshot(ref.path),
          set: (ref: { path: string }, data: Record<string, unknown>) =>
            pending.push([ref.path, data]),
        });
        for (const [path, data] of pending) write(path, data);
        return result;
      },
    } as unknown as Firestore;
    return { database, rows };
  }
  function occurrence(
    inputSets: Record<string, string>[] = [{}],
    data: unknown = { findings: 'f'.repeat(3 * 1024 * 1024) },
    id = 'c'.repeat(64),
  ): JobOccurrence {
    const definition = parseDefinition();
    return {
      id,
      jobId: 'b'.repeat(64),
      workId: 'work',
      requestDigest: 'd'.repeat(64),
      createdAt: new Date(0).toISOString(),
      principal: 'user:operator',
      trigger: 'manual',
      skipped: false,
      definition,
      profile: jobProfileSchema.parse({
        name: 'audit',
        repositories: ['octo/repo'],
        principals: ['user:operator'],
        allocation,
        inputSets,
      }),
      comparison: 'e'.repeat(64),
      parameters: {
        target: 'x'.repeat(REPOSITORY_JOB_PARAMETERS_MAX_BYTES - 20),
      },
      artifact: validateJobResult(definition, {
        report: 'Large result',
        complete: true,
        data,
      }),
    };
  }
  const save = (store: FirestoreJobStore, value: JobOccurrence) =>
    store.mutate(value.jobId, value.id, () => ({ occurrence: value }));

  it('stores a multi-MiB result and maximum parameters out of line and reads them back', async () => {
    const { database, rows } = memoryDatabase();
    const store = new FirestoreJobStore(database);
    // 3 MiB of data is staged twice (result.json and baseline): ~6 MiB.
    const value = occurrence();
    await save(store, value);
    expect(await store.readOccurrence(value.id)).toEqual(value);
    const stored = rows.get(`orchestrator-job-occurrences/${value.id}`)!;
    expect(stored['definition']).toBeUndefined();
    expect(stored['artifactJson']).toBeUndefined();
    expect(stored['artifactRef']).toMatchObject({ chunks: 7 });
    expect(
      [...rows.keys()].filter((path) =>
        path.startsWith('orchestrator-job-artifact-chunks/'),
      ),
    ).toHaveLength(7);
  });

  it('stores a definition once for every occurrence pinned to it', async () => {
    const { database, rows } = memoryDatabase();
    const store = new FirestoreJobStore(database);
    await save(store, occurrence([{}], {}, 'c'.repeat(64)));
    await save(store, occurrence([{}], {}, 'f'.repeat(64)));
    expect(
      [...rows.keys()].filter((path) =>
        path.startsWith('orchestrator-job-definitions/'),
      ),
    ).toHaveLength(1);
    expect((await store.readOccurrence('f'.repeat(64)))?.definition).toEqual(
      parseDefinition(),
    );
  });

  it('reads occurrences written with an inline definition and artifact', async () => {
    const { database, rows } = memoryDatabase();
    const { artifact, ...legacy } = occurrence([{}], { kept: [[1, 2], [3]] });
    rows.set(`orchestrator-job-occurrences/${legacy.id}`, {
      ...JSON.parse(JSON.stringify(legacy)),
      artifactJson: JSON.stringify(artifact),
    });
    const store = new FirestoreJobStore(database);
    expect(await store.readOccurrence(legacy.id)).toEqual({
      ...legacy,
      artifact,
    });
    // Rewriting a legacy occurrence moves its content out of line.
    await store.mutate(legacy.jobId, legacy.id, (_job, current) => ({
      occurrence: { ...current!, reconciledAt: new Date(0).toISOString() },
    }));
    const stored = rows.get(`orchestrator-job-occurrences/${legacy.id}`)!;
    expect(stored['definitionKey']).toBeDefined();
    expect(stored['artifactJson']).toBeUndefined();
    expect((await store.readOccurrence(legacy.id))?.artifact).toEqual(artifact);
  });

  it('refuses an artifact whose stored chunks do not match its digest', async () => {
    const { database, rows } = memoryDatabase();
    const store = new FirestoreJobStore(database);
    const value = occurrence([{}], { small: true });
    await save(store, value);
    const chunk = [...rows.keys()].find((path) =>
      path.startsWith('orchestrator-job-artifact-chunks/'),
    )!;
    rows.set(chunk, { data: Buffer.from('{"tampered":true}') });
    await expect(store.readOccurrence(value.id)).rejects.toThrow(
      /does not match its digest/u,
    );
  });

  it('lists a catalog and its sources beyond 500 rows', async () => {
    const docs = (count: number, row: (index: number) => object) => ({
      get: async () => ({
        size: count,
        docs: Array.from({ length: count }, (_, index) => ({
          data: () => row(index),
        })),
      }),
    });
    const database = {
      collection: (collection: string) =>
        collection === 'orchestrator-jobs'
          ? docs(600, (index) => ({
              id: index.toString(16).padStart(64, '0'),
              repository: 'octo/repo',
              name: `job-${index}`,
              error: 'Invalid YAML',
              refreshedAt: new Date(0).toISOString(),
              enabled: false,
            }))
          : docs(600, (index) => ({
              repository: `octo/repo-${index}`,
              refreshedAt: new Date(0).toISOString(),
            })),
    } as unknown as Firestore;
    const store = new FirestoreJobStore(database);
    expect(await store.list()).toHaveLength(600);
    expect((await store.sourceRefreshes()).size).toBe(600);
  });

  it('stores and reads a maximum result whose data is staged twice', async () => {
    const { database } = memoryDatabase();
    const store = new FirestoreJobStore(database);
    // At the 4 MiB result bound; result.json and baseline repeat it (~8 MiB).
    const value = occurrence([{}], {
      findings: 'f'.repeat(REPOSITORY_JOB_RESULT_MAX_BYTES - 1024),
    });
    await save(store, value);
    expect(await store.readOccurrence(value.id)).toEqual(value);
  });

  it('refuses an occurrence Firestore could not store, naming the record', async () => {
    const { database, rows } = memoryDatabase();
    const sets = Array.from({ length: 3 }, (_, index) => ({
      [`k${index}`]: 'x'.repeat(200 * 1024),
    }));
    await expect(
      save(new FirestoreJobStore(database), occurrence(sets)),
    ).rejects.toThrow(
      new RegExp(
        `Job occurrence is \\d+ bytes, above Firestore's ${FIRESTORE_DOCUMENT_MAX_BYTES}-byte`,
        'u',
      ),
    );
    expect(rows.has(`orchestrator-job-occurrences/${'c'.repeat(64)}`)).toBe(
      false,
    );
  });
});

describe('job secret values', () => {
  it("accept Secret Manager's full 64 KiB payload and no more", () => {
    expect(
      jobSecretValueSchema.parse('s'.repeat(JOB_SECRET_VALUE_MAX_BYTES)),
    ).toHaveLength(65536);
    expect(() =>
      jobSecretValueSchema.parse('s'.repeat(JOB_SECRET_VALUE_MAX_BYTES + 1)),
    ).toThrow();
    // Multi-byte text is measured in UTF-8 bytes, not characters.
    expect(() => jobSecretValueSchema.parse('é'.repeat(40_000))).toThrow();
  });
});
