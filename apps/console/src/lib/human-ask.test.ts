import { describe, expect, it } from 'vitest';

import { humanAskFromHandoff, humanDecisionFromHandoff } from './human-ask';

describe('the Inbox handoff format', () => {
  it('surfaces the exact operator ask ahead of context', () => {
    expect(
      humanAskFromHandoff(
        'Human ask: Approve the staged cutover.\r\n\r\nContext',
      ),
    ).toBe('Approve the staged cutover.');
  });

  it.each([
    undefined,
    'Runner authentication failed.',
    'Earlier handoff:\nHuman ask: Approve the staged cutover.',
    'Human ask:   ',
    'Human ask: ' + 'a'.repeat(401),
  ])('preserves the legacy display for %s', (handoff) => {
    expect(humanAskFromHandoff(handoff)).toBeUndefined();
  });

  it.each([
    'Human option: Keep it private',
    'Human option: Keep it private\nHuman option: KEEP IT PRIVATE',
    'Human approval: Approve staging\nHuman option: Keep it private',
    'Human option: First\nHuman option: Second\nHuman option: Third\nHuman option: Fourth\nHuman option: Fifth',
    '\nQuoted example:\nHuman approval: Approve staging',
  ])('keeps the ask but offers no controls for %s', (choices) => {
    expect(
      humanDecisionFromHandoff(
        `Human ask: Choose a staging policy.\n${choices}`,
      ),
    ).toEqual({ ask: 'Choose a staging policy.', choices: [] });
  });
});
