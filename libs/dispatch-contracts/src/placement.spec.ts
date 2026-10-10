import { describe, expect, it } from 'vitest';

import { executionPhase, runPlacementSchema } from './placement';

const now = Date.parse('2026-10-10T12:00:00Z');
const observedAt = new Date(now).toISOString();

describe('per-run execution phase', () => {
  it('keeps claim, placement, bootstrap and provider spawn distinct', () => {
    expect(
      executionPhase({ state: 'running', queue: { state: 'queued' } }, now),
    ).toBe('queued');
    expect(
      executionPhase({ state: 'running', queue: { state: 'claimed' } }, now),
    ).toBe('claimed');
    const queue = {
      state: 'claimed' as const,
      placement: {
        phase: 'waiting-for-placement' as const,
        reason: 'unschedulable' as const,
        observedAt,
      },
    };
    expect(executionPhase({ state: 'running', queue }, now)).toBe(
      'waiting-for-placement',
    );
    expect(
      executionPhase(
        {
          state: 'running',
          queue: {
            ...queue,
            placement: {
              ...queue.placement,
              phase: 'bootstrapping',
              reason: 'scheduled',
            },
          },
        },
        now,
      ),
    ).toBe('bootstrapping');
    expect(
      executionPhase(
        { state: 'running', queue: { ...queue, firstHeartbeatAt: observedAt } },
        now,
      ),
    ).toBe('bootstrapping');
    expect(
      executionPhase(
        {
          state: 'running',
          queue: { ...queue, providerProcessStartedAt: observedAt },
        },
        now,
      ),
    ).toBe('provider-execution');
  });
  it('does not invent queue state for legacy running records', () => {
    expect(executionPhase({ state: 'running' }, now)).toBe('unavailable');
    expect(executionPhase({ state: 'pending' }, now)).toBe('queued');
  });
  it('expires source observations and never revives terminal attempts', () => {
    const queue = {
      state: 'claimed' as const,
      placement: {
        phase: 'waiting-for-placement' as const,
        reason: 'pending' as const,
        observedAt,
      },
    };
    expect(executionPhase({ state: 'running', queue }, now + 180_001)).toBe(
      'unavailable',
    );
    expect(executionPhase({ state: 'running', queue }, now - 1)).toBe(
      'unavailable',
    );
    expect(executionPhase({ state: 'lost', queue }, now)).toBeUndefined();
    expect(
      executionPhase(
        {
          state: 'running',
          queue: {
            ...queue,
            placement: {
              ...queue.placement,
              phase: 'unavailable',
              reason: 'inventory-unavailable',
            },
          },
        },
        now,
      ),
    ).toBe('unavailable');
  });
  it('rejects raw scheduler reasons and unbounded payloads', () => {
    expect(
      runPlacementSchema.safeParse({
        phase: 'waiting-for-placement',
        reason: 'node-secret: failed',
        observedAt,
      }).success,
    ).toBe(false);
    expect(
      runPlacementSchema.safeParse({
        phase: 'waiting-for-placement',
        reason: 'pending',
        observedAt,
        message: 'raw scheduler event',
      }).success,
    ).toBe(false);
  });
});
