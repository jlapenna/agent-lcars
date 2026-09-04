import { describe, expect, it } from 'vitest';

import {
  claudeProjectSlugFor,
  resumeObjectPath,
  RUNNER_CAPTURE_AGENTS,
  runnerWatchRoots,
  transcriptObjectPath,
} from './runner-capture';

describe('runnerWatchRoots', () => {
  it('declares all captured agents unconditionally', () => {
    const roots = runnerWatchRoots({
      claudeProjectsDir: '/home/runner/.claude/projects',
      codexSessionsDir: '/home/runner/.codex/sessions',
      opencodeExportsDir: '/tmp/agent-lcars-opencode-exports',
    });

    expect(roots).toEqual([
      {
        path: '/home/runner/.claude/projects',
        adapter: 'claude-code',
        projectDirAllowlist: ['*'],
      },
      {
        path: '/home/runner/.codex/sessions',
        adapter: 'codex',
        recursive: true,
        cwdAllowlist: ['*'],
      },
      {
        path: '/tmp/agent-lcars-opencode-exports',
        adapter: 'opencode',
        projectDirAllowlist: ['sessions'],
      },
    ]);
  });

  it('is a pure function of its inputs (no hidden default paths)', () => {
    const roots = runnerWatchRoots({
      claudeProjectsDir: '/tmp/a',
      codexSessionsDir: '/tmp/b',
      opencodeExportsDir: '/tmp/c',
    });
    expect(roots[0].path).toBe('/tmp/a');
    expect(roots[1].path).toBe('/tmp/b');
    expect(roots[2].path).toBe('/tmp/c');
  });
});

describe('RUNNER_CAPTURE_AGENTS', () => {
  it('names exactly the agents runnerWatchRoots declares a root for', () => {
    expect(RUNNER_CAPTURE_AGENTS).toEqual(['claude-code', 'codex', 'opencode']);
  });
});

describe('transcriptObjectPath', () => {
  it('builds a per-agent path from the capturing adapter, not a hardcoded literal', () => {
    expect(
      transcriptObjectPath({
        runId: '42',
        adapter: 'claude-code',
        sessionId: 'session-a',
      }),
    ).toBe('runs/42/claude-code/session-a.jsonl');

    // The Bug 1 regression case (agent-lcars#645): before this function
    // existed, finalize.ts hardcoded the claude-code/ segment
    // unconditionally, so a Codex transcript archived under the wrong
    // per-agent prefix.
    expect(
      transcriptObjectPath({
        runId: '42',
        adapter: 'codex',
        sessionId: 'session-b',
      }),
    ).toBe('runs/42/codex/session-b.jsonl');

    expect(
      transcriptObjectPath({
        runId: '42',
        adapter: 'opencode',
        sessionId: 'ses_open_1',
      }),
    ).toBe('runs/42/opencode/ses_open_1.jsonl');
  });

  it('falls back to "unknown" when runId is absent, matching the old literal path', () => {
    expect(
      transcriptObjectPath({
        runId: undefined,
        adapter: 'claude-code',
        sessionId: 'session-c',
      }),
    ).toBe('runs/unknown/claude-code/session-c.jsonl');
  });
});

describe('resumeObjectPath', () => {
  it('names the resumable artifact beside the rendered one', () => {
    expect(
      resumeObjectPath({
        runId: 'work:01ABC/r1',
        adapter: 'opencode',
        sessionId: 's1',
      }),
    ).toBe('runs/work:01ABC/r1/opencode/s1.export.json');
  });
});

describe('claudeProjectSlugFor', () => {
  it.each([
    // Dot-free cases: unaffected by fix round 1 (widening the rule from
    // `/`-only to every non-alphanumeric character) — kept as originally
    // written.
    ['/home/jlapenna/p/agent-lcars', '-home-jlapenna-p-agent-lcars'],
    ['/tmp/agent-lcars-direct/checkout', '-tmp-agent-lcars-direct-checkout'],
    ['/', '-'],
    // A trailing slash: no normalization happens here (that's
    // `default-checkout.ts`'s `normalizeRoot`'s job, one layer up), so a
    // trailing `/` becomes a trailing `-`.
    ['/home/jlapenna/p/agent-lcars/', '-home-jlapenna-p-agent-lcars-'],
    // A dotted path segment, pinned against Claude Code's REAL on-disk
    // encoding (verified empirically — see this function's own doc
    // comment for how), not `checkoutSlugGlobs`'s looser `/`-only glob
    // rule: `.` is also replaced, one dash per character, un-collapsed.
    [
      '/home/runner/work/agent-lcars.git/repo',
      '-home-runner-work-agent-lcars-git-repo',
    ],
    // A dotted, hidden path segment (a leading `.`) — the double dash is
    // `/` then `.`, each becoming its own `-`, matching the real
    // `~/.claude/projects/` entry this was cross-checked against
    // (`/home/jlapenna/.openclaw` -> `-home-jlapenna--openclaw`).
    ['/home/jlapenna/.openclaw', '-home-jlapenna--openclaw'],
  ])(
    'replaces every non-alphanumeric character with "-": %s -> %s',
    (cwd, expected) => {
      expect(claudeProjectSlugFor(cwd)).toBe(expected);
    },
  );
});
