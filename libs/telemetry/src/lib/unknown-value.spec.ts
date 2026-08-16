import { describe, expect, it } from 'vitest';

import {
  isSafeIdentifier,
  TITLE_MAX_LENGTH,
  truncateTitle,
} from './unknown-value';

describe('truncateTitle', () => {
  it('collapses whitespace and leaves a short title alone', () => {
    expect(truncateTitle('  land   session\n titles  ')).toBe(
      'land session titles',
    );
  });

  it('ellipsizes a title longer than the maximum', () => {
    const title = truncateTitle('a'.repeat(TITLE_MAX_LENGTH + 20));
    expect(Array.from(title)).toHaveLength(TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  // Regression: the original implementation measured and sliced UTF-16 code
  // units, so a cut landing inside a surrogate pair emitted a lone surrogate.
  // JSON.stringify escapes that as \uXXXX and stays valid, so the damage only
  // appeared once the annotation was encoded to UTF-8 on its way to disk —
  // silent mojibake rather than a visible failure. An emoji sitting exactly at
  // the boundary is the reproducer.
  it('never splits an astral character into a lone surrogate', () => {
    // A surrogate that is not part of a complete pair. A *paired* surrogate is
    // perfectly legitimate — that is simply how an emoji is stored in UTF-16 —
    // so the defect is specifically an unmatched half.
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    // Sweep the cut across the emoji so one of these lands mid-pair.
    for (
      let filler = TITLE_MAX_LENGTH - 4;
      filler <= TITLE_MAX_LENGTH;
      filler += 1
    ) {
      const title = truncateTitle(
        `${'a'.repeat(filler)}\u{1F600}${'b'.repeat(10)}`,
      );

      expect(loneSurrogate.test(title)).toBe(false);
    }
  });

  it('survives a UTF-8 round trip when truncating at an emoji boundary', () => {
    const title = truncateTitle(
      `${'a'.repeat(TITLE_MAX_LENGTH - 2)}\u{1F600}bbb`,
    );

    expect(Buffer.from(title, 'utf8').toString('utf8')).toBe(title);
  });

  it('counts an all-emoji title by code point, not code unit', () => {
    // 80 emoji are 160 UTF-16 units. Measuring units would truncate a title
    // that is exactly at the limit; measuring code points must not.
    const title = truncateTitle('\u{1F600}'.repeat(TITLE_MAX_LENGTH));

    expect(Array.from(title)).toHaveLength(TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(false);
  });
});

describe('isSafeIdentifier', () => {
  it('accepts the real session ids both runtimes produce', () => {
    // Claude Code's CLAUDE_CODE_SESSION_ID and Codex's CODEX_THREAD_ID are
    // both UUIDs, and each names the transcript this id has to join onto.
    expect(isSafeIdentifier('69618f46-c334-4823-ba90-d484f6b64b06')).toBe(true);
    expect(isSafeIdentifier('01a007d8-6299-7471-b518-1118ab8e94af')).toBe(true);
  });

  it('rejects anything usable as a path component', () => {
    for (const value of [
      '',
      '.',
      '..',
      '../escape',
      'a/b',
      '.hidden',
      'a'.repeat(129),
    ]) {
      expect(isSafeIdentifier(value)).toBe(false);
    }
  });
});
