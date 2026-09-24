import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatClaimMarker } from '../../libs/dispatch-contracts/src/marker';
import policy from '../../packages/fleet-tools/bin/worker-policy.cjs';

const context = policy.prepareContext(
  {
    repository: 'octo/example',
    mode: 'implement',
    anchor: { type: 'issue', number: 42 },
  },
  {
    provider: 'codex',
    runId: 'octo/example#42/r1',
    attemptId: 'g1:octo/example#42/r1',
  },
);
// The shell policy and runtime verifier consume the canonical marker format.
const marker = formatClaimMarker(context.attemptId);
const shell = (command: string, cwd = '/tmp') => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
});
const deps = {
  readRepository: () => 'octo/example',
  assertWorktree: () => undefined,
  readOwnership: () => ({
    state: 'open',
    assignees: [{ login: process.env.AGENT_FLEET_LOGIN || 'agent-lcars-bot' }],
  }),
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('attempt marker repair before publication', () => {
  it('repairs a new PR once, preserving literal body text and flags', () => {
    const input = shell(
      `gh pr create -R octo/example -t 'Title' --body 'Text with $literal and "quotes"' --draft`,
    );
    const repaired = policy.repairArtifact(input, context, deps);
    const args = policy.literalCommands(repaired.command)[0];
    expect(args).toContain('--draft');
    expect(args.at(-1)).toBe(`Text with $literal and "quotes"\n\n${marker}`);
    expect(
      policy.repairArtifact(shell(repaired.command), context, deps),
    ).toBeNull();
  });
  it('reads a body file without modifying it', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcars-marker-repair-'));
    roots.push(root);
    writeFileSync(join(root, 'body.txt'), 'Original text');
    const repaired = policy.repairArtifact(
      shell('gh issue comment 42 --body-file body.txt', root),
      context,
      deps,
    );
    expect(policy.literalCommands(repaired.command)[0].at(-1)).toBe(
      `Original text\n\n${marker}`,
    );
    expect(readFileSync(join(root, 'body.txt'), 'utf8')).toBe('Original text');
  });
  it.each([
    'gh issue comment 43 --body unrelated',
    'gh pr create --repo foreign/repo --body unrelated',
    'gh pr edit 42 --body existing',
    'gh issue comment 42 --body unrelated && echo next',
  ])(
    'leaves non-target or unsupported artifact paths unchanged: %s',
    (command) => {
      expect(policy.repairArtifact(shell(command), context, deps)).toBeNull();
    },
  );
  it.each([
    'gh pr create --body "<!-- attempt-claim:foreign -->"',
    'gh issue comment 42 --body text --edit-last',
    'gh pr create --fill',
    'gh pr create --body-file -',
    'gh pr create --body text -b ambiguous',
  ])(
    'rejects ambiguous or foreign claims without publication: %s',
    (command) => {
      const result = policy.evaluate(shell(command), context, deps);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );
  it('repairs a review without requiring a code worktree', () => {
    const review = {
      ...context,
      mode: 'review',
      anchor: { type: 'pull-request', number: 42 },
    };
    const result = policy.evaluate(
      shell('gh pr review 42 --approve --body reviewed'),
      review,
      {
        ...deps,
        assertWorktree: () => {
          throw new Error('must not check');
        },
      },
    );
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(result.hookSpecificOutput.updatedInput.command).toContain(marker);
  });
  it('does not let a repaired body bypass ownership loss', () => {
    const result = policy.evaluate(
      shell('gh issue comment 42 --body done'),
      context,
      {
        ...deps,
        readOwnership: () => ({ state: 'closed', assignees: [] }),
      },
    );
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.updatedInput).toBeUndefined();
  });
});
