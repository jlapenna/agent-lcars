import { describe, expect, it } from 'vitest';

import { latestDueSlot, nextDueSlot, parseCron, slotItemId } from './cron';

const WORK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

describe('parseCron', () => {
  it('parses "*" fields as every value in range', () => {
    const spec = parseCron('* * * * *');
    expect(spec.minute.size).toBe(60);
    expect(spec.hour.size).toBe(24);
    expect(spec.dayOfMonth.size).toBe(31);
    expect(spec.month.size).toBe(12);
    expect(spec.dayOfWeek.size).toBe(7);
  });

  it('parses a list', () => {
    expect(
      [...parseCron('0,15,30,45 * * * *').minute].sort((a, b) => a - b),
    ).toEqual([0, 15, 30, 45]);
  });

  it('parses a range', () => {
    expect([...parseCron('0 9-17 * * *').hour].sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it('parses a step', () => {
    expect([...parseCron('*/15 * * * *').minute].sort((a, b) => a - b)).toEqual(
      [0, 15, 30, 45],
    );
  });

  it('parses a ranged step', () => {
    expect([...parseCron('0 8-20/4 * * *').hour].sort((a, b) => a - b)).toEqual(
      [8, 12, 16, 20],
    );
  });

  it.each([
    ['* * * *'],
    ['* * * * * *'],
    ['60 * * * *'],
    ['* 24 * * *'],
    ['x * * * *'],
    ['1-60 * * * *'],
    ['*/0 * * * *'],
  ])('throws on invalid expression "%s"', (expr) => {
    expect(() => parseCron(expr)).toThrow();
  });
});

describe('latestDueSlot', () => {
  it('returns the latest matching minute boundary at or before now', () => {
    const spec = parseCron('*/15 * * * *');
    const now = new Date('2026-08-27T10:22:30.000Z');
    expect(latestDueSlot(spec, now)?.toISOString()).toBe(
      '2026-08-27T10:15:00.000Z',
    );
  });

  it('returns undefined once `after` already covers the latest match', () => {
    const spec = parseCron('*/15 * * * *');
    const now = new Date('2026-08-27T10:22:30.000Z');
    const after = new Date('2026-08-27T10:15:00.000Z');
    expect(latestDueSlot(spec, now, after)).toBeUndefined();
  });

  it('returns the newer slot once now has advanced past it', () => {
    const spec = parseCron('*/15 * * * *');
    const now = new Date('2026-08-27T10:31:00.000Z');
    const after = new Date('2026-08-27T10:15:00.000Z');
    expect(latestDueSlot(spec, now, after)?.toISOString()).toBe(
      '2026-08-27T10:30:00.000Z',
    );
  });

  it('matches an exact minute boundary at now', () => {
    const spec = parseCron('0 * * * *');
    const now = new Date('2026-08-27T11:00:00.000Z');
    expect(latestDueSlot(spec, now)?.toISOString()).toBe(
      '2026-08-27T11:00:00.000Z',
    );
  });
});

describe('slotItemId', () => {
  const slot = new Date('2026-08-27T10:15:00.000Z');

  it('is deterministic for the same schedule and slot, and WORK_ID_RE-valid', async () => {
    const a = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    const b = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    expect(a).toBe(b);
    expect(a).toMatch(WORK_ID_RE);
  });

  it('differs for a different schedule or a different slot', async () => {
    const a = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    const b = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3H', slot);
    const c = await slotItemId(
      '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      new Date('2026-08-27T10:30:00.000Z'),
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("encodes the slot time as the id's 10-char prefix", async () => {
    const id = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = slot.getTime();
    let prefix = '';
    for (let i = 0; i < 10; i += 1) {
      prefix = ALPHABET[t % 32] + prefix;
      t = Math.floor(t / 32);
    }
    expect(id.slice(0, 10)).toBe(prefix);
  });
});

describe('field combination is ANDed, not POSIX dom-OR-dow', () => {
  it('matches only when day-of-month AND day-of-week both hold (pinning test)', () => {
    const spec = parseCron('0 0 1 * 1'); // the 1st, only when it is a Monday
    // 2026-06-01 is a Monday: dom=1 and dow=Monday both hold.
    expect(
      latestDueSlot(spec, new Date('2026-06-01T00:10:00.000Z'))?.toISOString(),
    ).toBe('2026-06-01T00:00:00.000Z');
    // Every day in (2026-08-01, 2026-09-02] either has dom=1 (2026-09-01,
    // a Tuesday) or dow=Monday (2026-08-03/10/17/24/31), never both. POSIX
    // cron ORs dom and dow when both are restricted, so it would fire on
    // any of them; this grammar ANDs every field, so none matches.
    expect(
      latestDueSlot(
        spec,
        new Date('2026-09-02T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).toBeUndefined();
  });
});

describe('nextDueSlot', () => {
  it('returns the earliest matching boundary at or after `from`', () => {
    const spec = parseCron('*/15 * * * *');
    const from = new Date('2026-08-27T10:22:30.000Z');
    expect(nextDueSlot(spec, from)?.toISOString()).toBe(
      '2026-08-27T10:30:00.000Z',
    );
  });

  it('returns `from` itself when it already matches', () => {
    const spec = parseCron('0 * * * *');
    const from = new Date('2026-08-27T11:00:00.000Z');
    expect(nextDueSlot(spec, from)?.toISOString()).toBe(
      '2026-08-27T11:00:00.000Z',
    );
  });

  it('returns undefined for an expression that can never fire within the horizon', () => {
    // No February has a 31st -- dom=31 and month=2 can never both hold.
    const spec = parseCron('0 0 31 2 *');
    expect(
      nextDueSlot(spec, new Date('2026-08-27T10:00:00.000Z')),
    ).toBeUndefined();
  });
});
