import { describe, expect, it } from 'vitest';

import {
  findCreatedPR,
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
    'gh pr create -dh',
    'gh pr create -dw',
    'gh pr create --unknown-flag',
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
    'gh pr create -df -t--help -bbody',
    'gh pr create --milestone next --recover saved',
    'gh pr create --title "--dry-run" --body "mentions gh pr create --help"',
  ])('retains actual creation: %s', (command) =>
    expect(isPRPublicationCommand(command)).toBe(true),
  );
});

describe('chained PR creation (#2730)', () => {
  const heredoc = (body: string, tag = "'EOF'") =>
    `gh pr create --draft --title "fix: x" --body "$(cat <<${tag}\n${body}\n${tag.replace(/['"]/gu, '')}\n)"`;

  it.each([
    'cd /home/u/p/repo-wt && gh pr create --draft --title t --body b',
    'GH_PROMPT_DISABLED=1 && gh pr create --fill',
    'export GH_PROMPT_DISABLED=1 && GIT_DIR=x gh pr create --fill',
    'cd repo &&\n  gh pr create --fill',
    'cd repo && gh pr create --fill\n',
    `cd repo && ${heredoc('## Problem\nmentions https://github.com/a/b/pull/12 and $HOME, `x`, && ; | \\n')}`,
    heredoc('plain body', 'EOF'),
    `cd repo && gh pr create --body "$(cat <<-'EOF'\n\tindented\n\tEOF\n)" --fill`,
  ])(
    'qualifies a create that ends an && chain of silent setup: %s',
    (command) => expect(isPRPublicationCommand(command)).toBe(true),
  );

  it.each([
    // Only && binds the create to its setup; ; and newlines start a new command.
    'cd repo; gh pr create --fill',
    'cd repo\ngh pr create --fill',
    'set -euo pipefail\ncd repo && gh pr create --fill',
    'gh pr create --fill\necho https://github.com/a/b/pull/1',
    'gh pr create --fill;',
    // The create is not last: a later segment can print another PR's URL.
    'gh pr create --fill && gh pr view 42',
    // Failure masking and output rewriting.
    'gh pr create --fill | tail -1',
    'gh pr create --fill 2>&1 | tail -1',
    'gh pr create --fill || true',
    'gh pr create --fill > /tmp/out',
    'gh pr create --fill &',
    'gh pr create --fill &> /tmp/out',
    // Setup that prints: commands, the directory stack, cd's echoed path.
    'gh pr list && gh pr create --fill',
    'echo https://github.com/a/b/pull/1 && gh pr create --fill',
    'set -x && gh pr create --body "see https://github.com/a/b/pull/1"',
    'set -e && gh pr create --fill',
    'pushd https://github.com/a/b/pull/1 && gh pr create --fill',
    'cd - && gh pr create --fill',
    'cd -P repo && gh pr create --fill',
    'cd && gh pr create --fill',
    'cd a b && gh pr create --fill',
    'CDPATH=/srv && cd https: && gh pr create --fill',
    'export CDPATH=/srv && cd repo && gh pr create --fill',
    'export && gh pr create --fill',
    // Environment that swaps the program or dumps API traffic.
    'PATH=/tmp/evil gh pr create --fill',
    'env PATH=/tmp/evil gh pr create --fill',
    'export PATH=/tmp/evil && gh pr create --fill',
    'GH_DEBUG=api gh pr create --fill',
    'BASH_ENV=/tmp/x && gh pr create --fill',
    // A path-qualified gh can be any program.
    './gh pr create --fill',
    '/tmp/evil/gh pr create --fill',
    // Malformed chains.
    'cd repo && && gh pr create --fill',
    '&& gh pr create --fill',
    'cd repo && gh pr create --fill &&',
    // Substitutions other than a literal heredoc body, and heredocs bash
    // would read differently.
    'cd repo && gh pr create --body "$(gh pr view 1)"',
    'gh pr create --body "$(cat <<EOF\nruns $(gh pr view 1)\nEOF\n)"',
    'gh pr create --body "$(cat <<EOF\n\\$(id)\nEOF\n)"',
    'gh pr create --body "$(cat <<\'EOF\'\nnever closed\n)"',
    'gh pr create --body "$(cat <<\'EOF\'\nEOF \n)"',
    'gh pr create --body "$(cat <<\'EOF\' >&2\nx\nEOF\n)"',
    'gh pr create --body "$(cat <<E"O"F\nx\nEOF\n)"',
    'gh pr create --body $(cat body.md)',
    'gh pr create --body "`cat body.md`"',
    "gh pr create --body $'line\\n'",
    '(gh pr create --fill)',
    '{ gh pr create --fill; }',
    // Non-creating create still rejected inside a chain.
    'cd repo && gh pr create --dry-run',
    `cd repo && gh pr create --body "$(cat <<'EOF'\nx\nEOF\n)" --help`,
  ])('leaves unqualified: %s', (command) =>
    expect(isPRPublicationCommand(command)).toBe(false),
  );
});

describe('created PR binding', () => {
  it('takes the one PR a create printed', () => {
    expect(
      findCreatedPR(
        'Warning: 1 uncommitted change\nhttps://github.com/a/b/pull/7\n',
      ),
    ).toEqual({ repo: { owner: 'a', name: 'b' }, number: 7 });
  });

  it('qualifies nothing when the output names several PRs', () => {
    expect(
      findCreatedPR(
        'https://github.com/a/b/pull/7\nhttps://github.com/a/b/pull/8',
      ),
    ).toBeUndefined();
    expect(findCreatedPR('no url')).toBeUndefined();
  });
});
