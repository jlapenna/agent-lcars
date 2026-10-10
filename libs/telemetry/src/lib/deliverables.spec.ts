import { describe, expect, it } from 'vitest';

import {
  findDeliverables,
  findQualifiedPRs,
  isPRPublicationCommand,
} from './deliverables';

describe('findDeliverables', () => {
  it('finds commit SHAs in bracket output without regex backtracking', () => {
    expect(
      findDeliverables(
        '[main abcdef1] first\n[feature 0123456789abcdef] second',
      ),
    ).toEqual({ prNumbers: [], commitShas: ['abcdef1', '0123456789abcdef'] });
  });

  it('skips malformed bracket output and continues scanning later entries', () => {
    expect(findDeliverables('[broken nope] [main fedcba9]')).toEqual({
      prNumbers: [],
      commitShas: ['fedcba9'],
    });
  });
});

describe('qualified GitHub publication URLs', () => {
  it('rejects non-GitHub hosts, relative numbers and malformed or unsafe identities', () => {
    expect(
      findQualifiedPRs(
        'https://github.com.evil.test/a/b/pull/42 /pull/42 https://github.com/a/b/pull/9007199254740999 https://github.com/a/b/pull/0',
      ),
    ).toEqual([]);
    expect(
      findQualifiedPRs(
        'https://github.com/a/b/pull/42#review https://github.com/A/B/pull/42',
      ),
    ).toEqual([{ repo: { owner: 'A', name: 'B' }, number: 42 }]);
  });
});

describe('actual PR creation invocation', () => {
  it.each([
    'gh pr create --dry-run',
    'gh pr create --dry-run=true',
    'gh pr create --help',
    'gh pr create -h',
    'echo "gh pr create"',
    "rg 'gh pr create' docs",
    '# gh pr create',
    'gh pr view 42 --jq "gh pr create"',
  ])('rejects non-creating uses: %s', (command) =>
    expect(isPRPublicationCommand(command)).toBe(false),
  );
  it.each([
    'gh pr create',
    'gh pr create --draft --body-file /tmp/body.md',
    'gh pr create --title "--dry-run" --body "mentions gh pr create --help"',
  ])('retains actual creation: %s', (command) =>
    expect(isPRPublicationCommand(command)).toBe(true),
  );
});
