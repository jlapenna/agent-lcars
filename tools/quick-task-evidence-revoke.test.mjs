/* eslint-disable vitest/no-import-node-test -- CI runs this via node --test (ci.yml), matching the other tools/ boundary tests; no vitest project covers tools/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseRevokeArgs,
  redactEvidenceId,
  revokeEvidence,
} from './quick-task-evidence-revoke.mjs';

const evidenceId = '0d6a4b56-31d0-4d39-b0b2-5a2520cc4882';
const input = {
  bucket: 'evidence',
  repositoryId: '42',
  requestId: 'request-1',
  evidenceId,
  generation: '7',
  apply: true,
};

function fixture({ repositoryId = '42', generation = '7' } = {}) {
  const calls = [];
  const object = {
    async getMetadata() {
      return [
        {
          generation,
          metadata: {
            schemaVersion: 'v1',
            evidenceId,
            repositoryId,
            requestId: 'request-1',
          },
        },
      ];
    },
    async delete(options) {
      calls.push(['delete', options]);
    },
  };
  const tombstone = {
    async save(bytes, options) {
      calls.push(['tombstone', bytes, options]);
    },
  };
  return {
    calls,
    bucket: {
      file(key) {
        return key.startsWith('objects/') ? object : tombstone;
      },
    },
  };
}

test('revocation defaults to dry run and redacts the bearer ID', async () => {
  const { bucket, calls } = fixture();
  const result = await revokeEvidence(bucket, { ...input, apply: false });
  assert.equal(result.action, 'dry-run');
  assert.equal(result.evidence, '0d6a4b56…');
  assert.deepEqual(calls, []);
  assert.equal(redactEvidenceId(evidenceId), '0d6a4b56…');
});

test('revocation writes the tombstone before generation-matched deletion', async () => {
  const { bucket, calls } = fixture();
  const result = await revokeEvidence(bucket, input);
  assert.equal(result.action, 'revoked');
  assert.equal(calls[0][0], 'tombstone');
  assert.deepEqual(calls[1], ['delete', { ifGenerationMatch: 7 }]);
  assert.equal(calls[0][2].preconditionOpts.ifGenerationMatch, 0);
});

test('cross-repository or generation mismatches fail closed before mutation', async () => {
  for (const options of [{ repositoryId: '43' }, { generation: '8' }]) {
    const { bucket, calls } = fixture(options);
    await assert.rejects(
      () => revokeEvidence(bucket, input),
      /binding could not be verified/,
    );
    assert.deepEqual(calls, []);
  }
});

test('the CLI requires all binding fields and an opaque UUID v4', () => {
  assert.throws(() => parseRevokeArgs([]), /Usage/);
  assert.throws(
    () => parseRevokeArgs(['--evidence-id', 'not-a-uuid']),
    /Usage/,
  );
});
