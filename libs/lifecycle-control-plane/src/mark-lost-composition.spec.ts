import { describe, expect, it } from 'vitest';

import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
} from './authority-storage';
import { MarkLostComposition } from './mark-lost-composition';
import { markLostRequest } from './mark-lost-history.spec.support';
import { activeFixture } from './terminal-finalizer.spec.support';

const NOW = '2026-08-22T00:01:00.000Z';

class Clock implements AuthorityClock {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

async function prepare() {
  const clock = new Clock(NOW);
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  const { lease, spec } = await activeFixture(storage);
  const composition = new MarkLostComposition({
    storage,
    clock,
    verifier: { verifyRunStuck: ({ candidate }) => candidate },
  });
  const request = await markLostRequest({ storage, lease, spec });
  return { clock, storage, lease, spec, composition, request };
}

describe('MarkLostComposition', () => {
  it('mints both capabilities and commits one terminal loss decision', async () => {
    const { storage, lease, spec, composition, request } = await prepare();

    await expect(composition.terminate({ lease, ...request })).resolves.toBe(
      'applied',
    );

    const attempt = await storage.readAttempt({
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    expect(attempt?.phase).toBe('terminal');
    expect(attempt?.outcome).toMatchObject({
      terminalState: 'lost',
      execution: 'lost',
      finalizedAt: NOW,
    });
  });

  it('replays the committed decision instead of re-deciding at a later clock', async () => {
    const { clock, storage, lease, spec, composition, request } =
      await prepare();
    await composition.terminate({ lease, ...request });

    clock.set('2026-08-22T00:45:00.000Z');
    await expect(composition.terminate({ lease, ...request })).resolves.toBe(
      'replay',
    );

    const attempt = await storage.readAttempt({
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    expect(attempt?.outcome?.finalizedAt).toBe(NOW);
  });

  it('refuses evidence the run-stuck boundary never verified', async () => {
    const { storage, lease, request } = await prepare();
    const unverified = new MarkLostComposition({
      storage,
      clock: new Clock(NOW),
      verifier: { verifyRunStuck: () => ({ kind: 'nonterminal' }) },
    });

    await expect(unverified.terminate({ lease, ...request })).rejects.toThrow();
  });

  it('refuses a receipt validated under a different lease incarnation', async () => {
    const { lease, composition, request } = await prepare();

    await expect(
      composition.terminate({
        lease: { ...lease, fence: lease.fence + 1 },
        ...request,
      }),
    ).rejects.toThrow();
  });

  it('refuses a terminal verifier status, which belongs to finalization', async () => {
    const { lease, composition, request } = await prepare();

    await expect(
      composition.terminate({
        lease,
        ...request,
        candidates: request.candidates.map((candidate, index) =>
          index === 2
            ? {
                ...(candidate as Record<string, unknown>),
                status: { kind: 'terminal', conclusion: 'failure' },
              }
            : candidate,
        ),
      }),
    ).rejects.toThrow();
  });
});
