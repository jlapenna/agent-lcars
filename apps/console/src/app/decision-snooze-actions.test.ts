import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  importDecisionSnoozes,
  readDecisionSnoozes,
  snoozeDecision,
  unsnoozeDecision,
} from './decision-snooze-actions';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  change: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/decision-snooze-store', () => ({
  getDecisionSnoozeStore: () => mocks,
}));
const input = { anchor: 'a/b#1', signature: 'current', minutes: 15 };
describe('decision snooze authorization and input boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: '1234', isAdmin: true } });
    mocks.read.mockResolvedValue({});
    mocks.change.mockResolvedValue({});
  });
  it.each([
    null,
    { user: { id: '1234', isAdmin: false } },
    { user: { id: '', isAdmin: true } },
  ])(
    'rejects an absent maintainer identity before touching preferences',
    async (session) => {
      mocks.auth.mockResolvedValue(session);
      for (const action of [
        () => readDecisionSnoozes(),
        () => snoozeDecision(input),
        () =>
          unsnoozeDecision({
            anchor: input.anchor,
            signature: input.signature,
          }),
        () => importDecisionSnoozes([]),
      ])
        await expect(action()).rejects.toThrow('Unauthorized');
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.change).not.toHaveBeenCalled();
    },
  );
  it('binds every action to the authenticated id, never a client-chosen user', async () => {
    await readDecisionSnoozes();
    await snoozeDecision(input);
    await unsnoozeDecision({
      anchor: input.anchor,
      signature: input.signature,
    });
    await importDecisionSnoozes([
      { anchor: input.anchor, signature: input.signature },
    ]);
    expect(mocks.read).toHaveBeenCalledWith('1234');
    expect(mocks.change.mock.calls).toEqual([
      ['1234', [input], 15],
      ['1234', [{ anchor: input.anchor, signature: input.signature }]],
      ['1234', [{ anchor: input.anchor, signature: input.signature }], 1440],
    ]);
    expect(
      (await snoozeDecision({ ...input, userId: 'someone-else' })).ok,
    ).toBe(false);
  });
  it.each([
    { ...input, minutes: 0 },
    { ...input, minutes: 100000 },
    { ...input, anchor: '__proto__' },
    { ...input, signature: '' },
    { ...input, signature: 'x'.repeat(1025) },
  ])('rejects unbounded or malformed client writes', async (value) => {
    expect((await snoozeDecision(value)).ok).toBe(false);
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('returns a safe error without exposing store errors or hidden credentials', async () => {
    mocks.change.mockRejectedValue(new Error('secret-token from backend'));
    const result = await snoozeDecision(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});
