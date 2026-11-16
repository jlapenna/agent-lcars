import { describe, expect, it } from 'vitest';

import { SCHEDULE_SPEC_MAX_BYTES, scheduleSchema } from './schedule-store';

const T = '2026-08-15T12:00:00.000Z';
const SCHEDULE_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const LAST_ITEM_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3H';

const base = {
  scheduleId: SCHEDULE_ID,
  cron: '*/15 * * * *',
  spec: { title: 't' },
  enabled: true,
  createdBy: 'user:jlapenna',
  createdAt: T,
  updatedAt: T,
};

describe('scheduleSchema', () => {
  it.each(['grant-revoked', 'operator', 'invalid'] as const)(
    'parses a full document with all optionals set (disabledReason: %s)',
    (disabledReason) => {
      const doc = {
        ...base,
        lastSlotAt: T,
        lastItemId: LAST_ITEM_ID,
        disabledReason,
      };
      expect(scheduleSchema.parse(doc)).toEqual(doc);
    },
  );

  it('rejects a document missing enabled', () => {
    const { enabled: _enabled, ...withoutEnabled } = base;
    expect(() => scheduleSchema.parse(withoutEnabled)).toThrow();
  });

  it('rejects a scheduleId that is not a valid ULID', () => {
    // lowercase -- WORK_ID_RE's character class is uppercase-only.
    expect(() =>
      scheduleSchema.parse({
        ...base,
        scheduleId: '01j5z3k9qx8f0n2b4v6c8d1e3g',
      }),
    ).toThrow();
    // 25 chars -- one short of the required 26.
    expect(() =>
      scheduleSchema.parse({
        ...base,
        scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3',
      }),
    ).toThrow();
    // I, L, O, U are excluded from Crockford base32.
    expect(() =>
      scheduleSchema.parse({
        ...base,
        scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3I',
      }),
    ).toThrow();
  });

  it('rejects an unknown top-level field (strict)', () => {
    expect(() =>
      scheduleSchema.parse({ ...base, unexpected: 'nope' }),
    ).toThrow();
  });

  it("rejects a disabledReason outside the enum ('other')", () => {
    expect(() =>
      scheduleSchema.parse({ ...base, disabledReason: 'other' }),
    ).toThrow();
  });

  it('shares the Work payload budget', () => {
    expect(SCHEDULE_SPEC_MAX_BYTES).toBe(262_144);
  });

  it('accepts a spec whose serialized UTF-8 length is exactly SCHEDULE_SPEC_MAX_BYTES', () => {
    // `{"blob":"` + n x's + `"}` = n + 11 bytes.
    const spec = { blob: 'x'.repeat(SCHEDULE_SPEC_MAX_BYTES - 11) };
    expect(new TextEncoder().encode(JSON.stringify(spec)).length).toBe(
      SCHEDULE_SPEC_MAX_BYTES,
    );
    expect(() => scheduleSchema.parse({ ...base, spec })).not.toThrow();
  });

  it('rejects a spec whose serialized UTF-8 length is one byte over SCHEDULE_SPEC_MAX_BYTES', () => {
    const spec = { blob: 'x'.repeat(SCHEDULE_SPEC_MAX_BYTES - 10) };
    expect(new TextEncoder().encode(JSON.stringify(spec)).length).toBe(
      SCHEDULE_SPEC_MAX_BYTES + 1,
    );
    expect(() => scheduleSchema.parse({ ...base, spec })).toThrow();
  });

  it('counts UTF-8 bytes, not UTF-16 code units, for multi-byte characters', () => {
    // 100,000 code units but 300,000 UTF-8 bytes (each '漢' is 3 bytes) --
    // must be rejected even though `.length` (code units) is under the cap.
    const spec = { blob: '漢'.repeat(100_000) };
    expect(spec.blob.length).toBeLessThan(SCHEDULE_SPEC_MAX_BYTES);
    expect(() => scheduleSchema.parse({ ...base, spec })).toThrow();
  });
});
