import { describe, expect, it } from 'vitest';

import { fontStack } from './font-stack';

describe('fontStack', () => {
  it('puts the extended face between the core face and its fallback', () => {
    expect(
      fontStack(
        { style: { fontFamily: "'bodyCore', 'bodyCore Fallback'" } },
        { style: { fontFamily: "'bodyExt'" } },
      ),
    ).toBe("'bodyCore', 'bodyExt', 'bodyCore Fallback'");
  });

  it('keeps a core face without a generated fallback first', () => {
    expect(
      fontStack(
        { style: { fontFamily: "'monoCore'" } },
        { style: { fontFamily: "'monoExt'" } },
      ),
    ).toBe("'monoCore', 'monoExt'");
  });
});
