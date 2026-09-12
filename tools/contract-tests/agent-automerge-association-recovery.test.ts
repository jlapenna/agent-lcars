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

const associationStart = restoreScript.indexOf(
  'if [ "$EVENT_NAME" = pull_request ]',
);
const associationEnd = restoreScript.indexOf(
  '# REST endpoint on purpose:',
  associationStart,
);
if (associationStart < 0 || associationEnd < 0) {
  throw new Error('workflow-run association block not found');
}
const associationScript = `${restoreScript.slice(
  associationStart,
  associationEnd,
)}printf 'SELECTED_PR=%s\\n' "$PR"\n`;

const headSha = 'a'.repeat(40);

type Pull = {
  number: number;
  state: 'open' | 'closed';
  merged_at: string | null;
  updated_at: string;
  head: { sha: string };
};

function pull(number: number, overrides: Partial<Pull> = {}): Pull {
  return {
    number,
    state: 'open',
    merged_at: null,
    updated_at: `2026-09-12T12:${String(number).padStart(2, '0')}:00Z`,
    head: { sha: headSha },
    ...overrides,
  };
}

function executeAssociation({
  payload = [],
  responses = [],
  mutateToSingleLookup = false,
}: {
  payload?: Pull[] | null;
  responses?: Array<Pull | Pull[] | 'error'>;
  mutateToSingleLookup?: boolean;
}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'association-recovery-'));
  const callsPath = path.join(temp, 'calls');
  const responseIndexPath = path.join(temp, 'response-index');
  const responsesPath = path.join(temp, 'responses');
  const fakeGh = path.join(temp, 'gh');
  const fakeSleep = path.join(temp, 'sleep');
  writeFileSync(callsPath, '');
  writeFileSync(responseIndexPath, '0');
  writeFileSync(responsesPath, JSON.stringify(responses));
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$CALLS_PATH"
index=$(cat "$RESPONSE_INDEX_PATH")
response=$(jq -c --argjson index "$index" '.[$index]' "$RESPONSES_PATH")
echo $((index + 1)) > "$RESPONSE_INDEX_PATH"
if [ "$response" = '"error"' ] || [ "$response" = null ]; then
  exit 1
fi
printf '%s\\n' "$response"
`,
  );
  writeFileSync(
    fakeSleep,
    '#!/usr/bin/env bash\necho "sleep:$*" >> "$CALLS_PATH"\n',
  );
  chmodSync(fakeGh, 0o755);
  chmodSync(fakeSleep, 0o755);

  const script = mutateToSingleLookup
    ? associationScript.replace(
        'for attempt in $(seq 1 6); do',
        'for attempt in 1; do',
      )
    : associationScript;
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${temp}:${process.env['PATH'] ?? ''}`,
      CALLS_PATH: callsPath,
      RESPONSE_INDEX_PATH: responseIndexPath,
      RESPONSES_PATH: responsesPath,
      EVENT_NAME: 'workflow_run',
      EVENT_PR: '',
      EVENT_WORKFLOW_PRS: JSON.stringify(payload),
      HEAD_SHA: headSha,
      REPO: 'o/r',
    },
  });
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

describe('workflow-run PR association recovery', () => {
  it('uses an exact-head payload association without a commit-association lookup', () => {
    const result = executeAssociation({
      payload: [pull(4, { head: { sha: 'b'.repeat(40) } }), pull(7)],
      responses: [pull(7)],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('SELECTED_PR=7');
    expect(result.calls).toEqual(['api repos/o/r/pulls/7']);
  });

  it('falls back when payload PR verification returns another head', () => {
    const result = executeAssociation({
      payload: [pull(10)],
      responses: [pull(10, { head: { sha: 'b'.repeat(40) } }), [pull(11)]],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('SELECTED_PR=11');
    expect(result.calls).toEqual([
      'api repos/o/r/pulls/10',
      `api repos/o/r/commits/${headSha}/pulls`,
    ]);
  });

  it('falls back when payload PR verification fails transiently', () => {
    const result = executeAssociation({
      payload: [pull(12)],
      responses: ['error', [pull(13)]],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('could not be verified');
    expect(result.output).toContain('SELECTED_PR=13');
  });

  it('falls back when the payload PR was closed without merging', () => {
    const result = executeAssociation({
      payload: [pull(14)],
      responses: [pull(14, { state: 'closed' }), [pull(15)]],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('SELECTED_PR=15');
  });

  it('recovers when an empty association becomes a merged PR', () => {
    const result = executeAssociation({
      payload: null,
      responses: [
        [],
        [
          pull(8, {
            state: 'closed',
            merged_at: '2026-09-12T12:21:31Z',
          }),
        ],
      ],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('SELECTED_PR=8');
    expect(result.calls.filter((call) => call.startsWith('api '))).toHaveLength(
      2,
    );
    expect(result.calls).toContain('sleep:5');
  });

  it('demonstrates that the old single lookup misses delayed association', () => {
    const result = executeAssociation({
      payload: null,
      responses: [[], [pull(8)]],
      mutateToSingleLookup: true,
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('SELECTED_PR=8');
    expect(result.calls.filter((call) => call.startsWith('api '))).toHaveLength(
      1,
    );
  });

  it('ignores unrelated and unmerged closed candidates and selects deterministically', () => {
    const result = executeAssociation({
      responses: [
        [
          pull(20, { head: { sha: 'c'.repeat(40) } }),
          pull(21, { state: 'closed' }),
          pull(22, {
            state: 'closed',
            merged_at: '2026-09-12T12:20:00Z',
          }),
          pull(23),
        ],
      ],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('SELECTED_PR=23');
  });

  it('finishes as a bounded no-op when successful lookups remain unrelated', () => {
    const result = executeAssociation({
      responses: Array.from({ length: 6 }, () => [
        pull(30, { head: { sha: 'd'.repeat(40) } }),
      ]),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      'No matching open or merged pull request is associated',
    );
    expect(result.calls.filter((call) => call.startsWith('api '))).toHaveLength(
      6,
    );
    expect(result.calls.filter((call) => call === 'sleep:5')).toHaveLength(5);
  });

  it('fails closed after bounded persistent API errors', () => {
    const result = executeAssociation({
      responses: Array.from({ length: 6 }, () => 'error' as const),
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain('restoration ownership is unknown');
    expect(result.calls.filter((call) => call.startsWith('api '))).toHaveLength(
      6,
    );
  });

  it('recovers from a transient API error', () => {
    const result = executeAssociation({
      responses: ['error', [pull(40)]],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('attempt 1/6');
    expect(result.output).toContain('SELECTED_PR=40');
  });
});
