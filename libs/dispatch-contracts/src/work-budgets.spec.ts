import { describe, expect, it } from 'vitest';

import {
  CLAW_INVESTIGATE_OPERATION,
  clawInvestigateInputSchema,
} from './claw-investigate';
import {
  fitsWorkDescription,
  fitsWorkParamText,
  RUN_PARAMS_MAX_BYTES,
  serializedJsonBytes,
  WORK_DESCRIPTION_MAX_BYTES,
  WORK_PARAM_TEXT_MAX_BYTES,
  WORK_PAYLOAD_MAX_BYTES,
} from './work-budgets';

const FIRESTORE_DOCUMENT_MAX_BYTES = 1_048_576;
const MAX_ARG_STRLEN = 131_072;
const GITHUB_BODY_MAX_CHARACTERS = 65_536;

describe('Work byte budgets', () => {
  it('derive from the real platform limits they protect', () => {
    // A task or schedule document holds two payloads.
    expect(2 * WORK_PAYLOAD_MAX_BYTES).toBeLessThanOrEqual(
      FIRESTORE_DOCUMENT_MAX_BYTES / 2,
    );
    // A run document holds its source revision and its parameters.
    expect(WORK_PAYLOAD_MAX_BYTES + RUN_PARAMS_MAX_BYTES).toBeLessThan(
      FIRESTORE_DOCUMENT_MAX_BYTES,
    );
    // Two maximal text parameters fit the record with metadata room.
    expect(2 * WORK_PARAM_TEXT_MAX_BYTES).toBeLessThan(RUN_PARAMS_MAX_BYTES);
    // One parameter fits one Linux argument or environment string.
    expect(WORK_PARAM_TEXT_MAX_BYTES).toBeLessThan(MAX_ARG_STRLEN);
  });

  it('keeps a complete GitHub body whole in a description', () => {
    expect(fitsWorkDescription('漢'.repeat(GITHUB_BODY_MAX_CHARACTERS))).toBe(
      true,
    );
    expect(fitsWorkDescription('\n'.repeat(GITHUB_BODY_MAX_CHARACTERS))).toBe(
      true,
    );
    expect(
      fitsWorkDescription('x'.repeat(WORK_DESCRIPTION_MAX_BYTES - 1)),
    ).toBe(false);
  });

  it('measures serialized UTF-8 bytes, including JSON escapes', () => {
    expect(serializedJsonBytes('\n')).toBe(4);
    expect(serializedJsonBytes('漢')).toBe(5);
    expect(fitsWorkParamText('x'.repeat(WORK_PARAM_TEXT_MAX_BYTES - 2))).toBe(
      true,
    );
    expect(fitsWorkParamText('x'.repeat(WORK_PARAM_TEXT_MAX_BYTES - 1))).toBe(
      false,
    );
  });
});

describe('clawInvestigateInputSchema', () => {
  it('accepts a question past the retired 4,000-character cap', () => {
    const question = 'q'.repeat(50_000);
    expect(clawInvestigateInputSchema.parse({ question }).question).toBe(
      question,
    );
  });

  it('refuses a question whose revision input exceeds the payload budget', () => {
    const overhead = serializedJsonBytes({
      operation: CLAW_INVESTIGATE_OPERATION,
      question: '',
    });
    const fits = 'q'.repeat(WORK_PAYLOAD_MAX_BYTES - overhead);
    expect(
      clawInvestigateInputSchema.safeParse({ question: fits }).success,
    ).toBe(true);
    expect(
      clawInvestigateInputSchema.safeParse({ question: `${fits}q` }).error
        ?.issues[0]?.message,
    ).toMatch(/serialized Work payload budget/u);
  });

  it('still refuses a blank question', () => {
    expect(
      clawInvestigateInputSchema.safeParse({ question: '   ' }).success,
    ).toBe(false);
  });
});
