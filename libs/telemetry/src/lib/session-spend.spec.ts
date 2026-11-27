import { describe, expect, it } from 'vitest';

import {
  sessionSpendForWrite,
  sessionSpendFromStored,
  storedTokenUsage,
} from './session-spend';
import { SessionDoc, SessionWrite } from './types';

const USAGE = {
  inputTokens: 1_000,
  outputTokens: 500,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

function sessionWrite(overrides: Partial<SessionDoc> = {}): SessionWrite {
  return {
    doc: {
      sessionId: 'session-1',
      source: 'cli',
      liveness: 'live',
      startedAt: '2026-11-01T10:00:00.000Z',
      lastActivityAt: '2026-11-01T10:05:00.000Z',
      turns: 1,
      toolCallCounts: {},
      tokens: USAGE,
      deliverables: { prNumbers: [], commitShas: [] },
      ...overrides,
    } as SessionDoc,
    clearFields: [],
  };
}

describe('storedTokenUsage', () => {
  it('accepts a complete persisted token map', () => {
    expect(storedTokenUsage(USAGE)).toEqual(USAGE);
  });

  it('rejects a map missing a member instead of materializing NaN', () => {
    expect(
      storedTokenUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 }),
    ).toBeUndefined();
    expect(
      storedTokenUsage({
        inputTokens: 1,
        outputTokens: Number.NaN,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeUndefined();
    expect(storedTokenUsage(undefined)).toBeUndefined();
    expect(storedTokenUsage('nope')).toBeUndefined();
  });
});

describe('sessionSpendFromStored', () => {
  it('re-derives what the writer stored for the same session', () => {
    const write = sessionWrite({
      model: 'claude-sonnet-4-5',
      totalCostUsd: 1.25,
    });
    const written = sessionSpendForWrite(write, undefined);

    expect(
      sessionSpendFromStored({
        tokens: write.doc.tokens,
        model: write.doc.model,
        resolvedModel: write.doc.resolvedModel,
        totalCostUsd: write.doc.totalCostUsd,
      }),
    ).toEqual(written);
  });

  it('prices a doc with no recorded cost from its model', () => {
    const derived = sessionSpendFromStored({
      tokens: USAGE,
      model: 'claude-sonnet-4-5',
      resolvedModel: undefined,
      totalCostUsd: undefined,
    });

    expect(derived).toBeDefined();
    expect(derived?.tokens).toBe(1_500);
    expect(derived?.costUsd).toBeGreaterThan(0);
  });

  it('leaves a doc whose usage was never read unpriced rather than free', () => {
    expect(
      sessionSpendFromStored({
        tokens: undefined,
        model: 'claude-sonnet-4-5',
        resolvedModel: undefined,
        totalCostUsd: undefined,
      }),
    ).toBeUndefined();
  });

  it('floors a recorded negative cost the way the writer does', () => {
    expect(
      sessionSpendFromStored({
        tokens: USAGE,
        model: 'claude-sonnet-4-5',
        resolvedModel: undefined,
        totalCostUsd: -3,
      })?.costUsd,
    ).toBe(0);
  });
});
