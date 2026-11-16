import {
  JOB_SECRET_VALUE_MAX_BYTES,
  jobSecretValueSchema,
  REPOSITORY_JOB_PARAMETERS_MAX_BYTES,
  REPOSITORY_JOB_REQUEST_MAX_BYTES,
} from '@agent-lcars/work';
import type { Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
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

  function fakeDatabase() {
    const set = vi.fn();
    const database = {
      collection: (collection: string) => ({
        doc: (id: string) => ({ path: `${collection}/${id}` }),
      }),
      runTransaction: async (run: (transaction: unknown) => Promise<unknown>) =>
        run({ get: async () => ({ exists: false }), set }),
    } as unknown as Firestore;
    return { database, set };
  }
  function occurrence(inputSets: Record<string, string>[]): JobOccurrence {
    const definition = parseDefinition();
    return {
      id: 'c'.repeat(64),
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
        // Staged results store data twice (result.json and baseline).
        data: { findings: 'f'.repeat(150 * 1024) },
      }),
    };
  }

  it('stores a maximum parameter map beside a large result', async () => {
    const { database, set } = fakeDatabase();
    await new FirestoreJobStore(database).mutate(
      'b'.repeat(64),
      'c'.repeat(64),
      () => ({ occurrence: occurrence([{}]) }),
    );
    expect(set).toHaveBeenCalledOnce();
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

  it('stores a full result whose data is staged twice beyond the former 384 KiB', async () => {
    const { database, set } = fakeDatabase();
    const value = occurrence([{}]);
    const definition = value.definition;
    // ~250 KiB of data: within the 256 KiB result bound, ~500 KiB staged.
    const artifact = validateJobResult(definition, {
      report: 'Near-limit result',
      complete: true,
      data: { findings: 'f'.repeat(250 * 1024) },
    });
    await new FirestoreJobStore(database).mutate(
      'b'.repeat(64),
      'c'.repeat(64),
      () => ({ occurrence: { ...value, parameters: {}, artifact } }),
    );
    expect(set).toHaveBeenCalledOnce();
  });

  it('refuses an occurrence Firestore could not store, naming the record', async () => {
    const { database, set } = fakeDatabase();
    const sets = Array.from({ length: 4 }, (_, index) => ({
      [`k${index}`]: 'x'.repeat(200 * 1024),
    }));
    await expect(
      new FirestoreJobStore(database).mutate(
        'b'.repeat(64),
        'c'.repeat(64),
        () => ({ occurrence: occurrence(sets) }),
      ),
    ).rejects.toThrow(
      new RegExp(
        `Job occurrence is \\d+ bytes, above Firestore's ${FIRESTORE_DOCUMENT_MAX_BYTES}-byte`,
        'u',
      ),
    );
    expect(set).not.toHaveBeenCalled();
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
