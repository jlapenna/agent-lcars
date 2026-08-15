import { describe, expect, it } from 'vitest';

import { DefinitiveNoRunBoundary } from './launch-rejection-capability';

const validProof = () => ({
  tenantId: 'tenant-rejection',
  repositoryId: 101,
  task: { tenantId: 'tenant-rejection', repositoryId: 101, issueNumber: 7 },
  attemptId: 'A'.repeat(22),
  operationId: 'A'.repeat(22),
  executionEpoch: 1,
  proofSha256: 'a'.repeat(64),
});

function boundary(proof: unknown) {
  return new DefinitiveNoRunBoundary(
    { verify: async () => proof as never },
    { now: () => '2026-08-22T00:01:00.000Z' },
  );
}

describe('DefinitiveNoRunBoundary', () => {
  it('strictly parses, clones, and deeply freezes definitive no-run proof', async () => {
    const input = validProof();
    const verified = await boundary(input).verify({
      proof: undefined,
      expectedAttemptRevision: 1,
    });
    input.task.issueNumber = 8;
    expect(verified.proof.task.issueNumber).toBe(7);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.proof)).toBe(true);
    expect(Object.isFrozen(verified.proof.task)).toBe(true);
  });

  it.each([
    [
      'boxed digest',
      { ...validProof(), proofSha256: new String('a'.repeat(64)) },
    ],
    ['extra field', { ...validProof(), ignored: true }],
    [
      'malformed task',
      { ...validProof(), task: { tenantId: 'tenant-rejection' } },
    ],
    [
      'cyclic proof',
      (() => {
        const proof = validProof() as Record<string, unknown>;
        proof.loop = proof;
        return proof;
      })(),
    ],
    [
      'throwing proxy',
      new Proxy(validProof(), {
        get() {
          throw new Error('untrusted getter');
        },
      }),
    ],
  ])('fails closed for %s verifier output', async (_name, proof) => {
    await expect(
      boundary(proof).verify({ proof: undefined, expectedAttemptRevision: 1 }),
    ).rejects.toThrow('Definitive no-run proof is invalid');
  });
});
