import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Behavioral + presence fixtures for restore-main-checks' "Delete the
// merged PR's head branch ourselves" logic (agent-lcars#1982). Same
// actor-identity gap the "close the PR's linked issues ourselves" logic
// already works around (agent-lcars#214): GitHub's delete_branch_on_merge
// side effect never fires for a merge performed by this job's ephemeral
// GITHUB_TOKEN, only for a human or GitHub App identity - measured A/B in
// jlapenna/homelab PR #1410 (GITHUB_TOKEN merge, branch kept) vs. #1412
// (App-identity merge, branch auto-deleted). Same technique as the
// sibling association-recovery test: extract the real bash block from the
// workflow (not a reimplementation) and execute it against a scripted fake
// `gh`, asserting on its actual output and call sequence.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowText = readFileSync(
  path.join(repoRoot, '.github/workflows/agent-automerge-reusable.yml'),
  'utf8',
);
const workflow = parse(workflowText) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const restoreScript = workflow.jobs['restore-main-checks'].steps.find(
  (step) => step.name === 'Dispatch missing post-merge CI/deploy runs',
)?.run;
if (!restoreScript) throw new Error('restore-main-checks shell step not found');

const branchDeleteStart = restoreScript.indexOf(
  "# Delete the merged PR's head branch ourselves.",
);
const branchDeleteEnd = restoreScript.indexOf(
  'if [ -z "$CI_WORKFLOW" ]',
  branchDeleteStart,
);
if (branchDeleteStart < 0 || branchDeleteEnd < 0) {
  throw new Error('restore-main-checks head-branch-deletion block not found');
}
const branchDeleteScript = `${restoreScript.slice(
  branchDeleteStart,
  branchDeleteEnd,
)}printf 'DONE\\n'\n`;

type FakeGhResponse = { stdout?: string; stderr?: string; exit?: number };

function runBranchDeletion(responses: FakeGhResponse[]) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'head-branch-deletion-'));
  const callsPath = path.join(temp, 'calls');
  const responseIndexPath = path.join(temp, 'response-index');
  const responsesPath = path.join(temp, 'responses');
  const fakeGh = path.join(temp, 'gh');
  writeFileSync(callsPath, '');
  writeFileSync(responseIndexPath, '0');
  writeFileSync(responsesPath, JSON.stringify(responses));
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$CALLS_PATH"
index=$(cat "$RESPONSE_INDEX_PATH")
entry=$(jq -c --argjson i "$index" '.[$i]' "$RESPONSES_PATH")
echo $((index + 1)) > "$RESPONSE_INDEX_PATH"
stdout=$(jq -r '.stdout // ""' <<<"$entry")
stderr=$(jq -r '.stderr // ""' <<<"$entry")
exitCode=$(jq -r '.exit // 0' <<<"$entry")
if [ -n "$stdout" ]; then printf '%s\\n' "$stdout"; fi
if [ -n "$stderr" ]; then printf '%s\\n' "$stderr" >&2; fi
exit "$exitCode"
`,
  );
  chmodSync(fakeGh, 0o755);

  const result = spawnSync(
    'bash',
    ['-euo', 'pipefail', '-c', branchDeleteScript],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env['PATH'] ?? ''}`,
        CALLS_PATH: callsPath,
        RESPONSE_INDEX_PATH: responseIndexPath,
        RESPONSES_PATH: responsesPath,
        PR: '42',
        REPO: 'o/r',
      },
    },
  );
  const calls = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  rmSync(temp, { recursive: true, force: true });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls,
  };
}

describe('restore-main-checks head-branch-deletion contract', () => {
  it('mentions the RCA (issue #1982) and the #214 precedent it mirrors', () => {
    const block = restoreScript.slice(branchDeleteStart, branchDeleteEnd);
    expect(block).toContain('agent-lcars#214');
    expect(block).toContain('agent-lcars#1982');
  });

  it('skips deletion when the repository has delete_branch_on_merge off', () => {
    const result = runBranchDeletion([{ stdout: 'false' }]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      'api repos/o/r --jq .delete_branch_on_merge',
    ]);
    expect(result.output).toContain('delete_branch_on_merge is off');
    expect(result.output).toContain('DONE');
  });

  it('never deletes a fork PR head branch (isCrossRepository)', () => {
    const result = runBranchDeletion([
      { stdout: 'true' },
      {
        stdout: JSON.stringify({
          headRefName: 'feature-x',
          headRepositoryOwner: { login: 'someone-else' },
          isCrossRepository: true,
        }),
      },
    ]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      'api repos/o/r --jq .delete_branch_on_merge',
      'pr view 42 --repo o/r --json headRefName,headRepositoryOwner,isCrossRepository',
    ]);
    expect(result.output).toContain('lives in a fork');
    expect(result.output).toContain('DONE');
  });

  it('deletes the head branch of a same-repo PR when the setting is on', () => {
    const result = runBranchDeletion([
      { stdout: 'true' },
      {
        stdout: JSON.stringify({
          headRefName: 'feature-y',
          headRepositoryOwner: { login: 'o' },
          isCrossRepository: false,
        }),
      },
      {},
    ]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      'api repos/o/r --jq .delete_branch_on_merge',
      'pr view 42 --repo o/r --json headRefName,headRepositoryOwner,isCrossRepository',
      'api -X DELETE repos/o/r/git/refs/heads/feature-y',
    ]);
    expect(result.output).toContain('Deleted head branch feature-y');
    expect(result.output).not.toContain('::warning::');
  });

  it.each([
    ['HTTP 422', 'gh: Reference does not exist (HTTP 422)'],
    ['HTTP 404', 'gh: Not Found (HTTP 404)'],
  ])(
    'tolerates a %s delete failure (branch already gone) as success',
    (_label, stderr) => {
      const result = runBranchDeletion([
        { stdout: 'true' },
        {
          stdout: JSON.stringify({
            headRefName: 'feature-z',
            headRepositoryOwner: { login: 'o' },
            isCrossRepository: false,
          }),
        },
        { exit: 1, stderr },
      ]);
      expect(result.status).toBe(0);
      expect(result.output).toContain('was already gone (HTTP 422/404)');
      expect(result.output).not.toContain('::warning::');
    },
  );

  it('logs a non-fatal warning for any other delete failure', () => {
    const result = runBranchDeletion([
      { stdout: 'true' },
      {
        stdout: JSON.stringify({
          headRefName: 'feature-w',
          headRepositoryOwner: { login: 'o' },
          isCrossRepository: false,
        }),
      },
      { exit: 1, stderr: 'gh: Bad credentials (HTTP 401)' },
    ]);
    // A leftover branch is not worth a red check: the job must not fail.
    expect(result.status).toBe(0);
    expect(result.output).toContain(
      '::warning::Could not delete head branch feature-w',
    );
    expect(result.output).toContain('HTTP 401');
    expect(result.output).toContain('DONE');
  });
});
