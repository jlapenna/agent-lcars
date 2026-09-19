import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `agent-option:*` only means something if some code actually reads the
 * label. #1997 exists because `agent-option:long-run` sat in
 * `config/github-labels.json` (and its per-repo lists, and
 * `docs/github-label-contract.md`) for months after #1599 deleted its only
 * consumer -- `label-contract-audit.yml` re-minted the label on GitHub every
 * day the whole time, because that audit only proves the label *exists*, not
 * that anything reads it.
 *
 * This walks every `agent-option:*` name declared in the manifest and
 * asserts the exact label string appears somewhere in real (non-test)
 * source under one of the three places a run can actually act on it: the
 * console (label read at admission/dispatch), the shared Work contract (the
 * brief field carrying the decision to the runner), or the runner image
 * (where the resulting behavior executes). A label that only appears in a
 * *test* asserting behavior nothing implements, or nowhere at all, fails
 * here. Was red for `agent-option:long-run` before #1997's fix (proved by
 * temporarily re-adding the label and re-running this file); green once the
 * manifest no longer declares it.
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(repoRoot, 'config/github-labels.json');

// Where a label's actual behavior can live -- mirrors #1997's own scoping
// of the "wire it" branch it did not take: the console reads labels at
// admission/dispatch, libs/work carries the resulting brief field, and the
// runner image is where a budget/behavior change would actually execute.
const CONSUMER_ROOTS = [
  'apps/console/src',
  'libs/work/src',
  'apps/runner-autoscaler/runner-image',
];

// Build output or dependency trees should never make this pass for the
// wrong reason; none exist under the roots above today, but guard anyway.
const SKIP_DIR_NAMES = new Set(['node_modules', '.next', 'dist', 'coverage']);

// A consumer reference must live in real source, not in a test asserting
// behavior that does not exist -- matches this repo's own test-naming
// convention (`*.test.ts`, `*.test.sh`, `*.spec.ts`, ...).
const TEST_FILE_RE = /\.(test|spec)\.[^./]+$/;

interface LabelManifest {
  labels: Record<string, { color: string; description: string }>;
}

function readManifest(): LabelManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as LabelManifest;
}

function isUnderSkippedDir(absRoot: string, absDir: string): boolean {
  const relativeSegments = path.relative(absRoot, absDir).split(path.sep);
  return relativeSegments.some((segment) => SKIP_DIR_NAMES.has(segment));
}

function readNonTestSource(root: string): string {
  const absRoot = path.join(repoRoot, root);
  const entries = readdirSync(absRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const contents: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (TEST_FILE_RE.test(entry.name)) continue;
    if (isUnderSkippedDir(absRoot, entry.parentPath)) continue;
    contents.push(
      readFileSync(path.join(entry.parentPath, entry.name), 'utf8'),
    );
  }
  return contents.join('\n');
}

describe('agent-option:* labels all have a real consumer', () => {
  const manifest = readManifest();
  const agentOptionLabels = Object.keys(manifest.labels).filter((name) =>
    name.startsWith('agent-option:'),
  );

  it('found at least one agent-option:* label to check (contract is not vacuous)', () => {
    expect(agentOptionLabels.length).toBeGreaterThan(0);
  });

  const consumerSource = CONSUMER_ROOTS.map(readNonTestSource).join('\n');

  it.each(agentOptionLabels)(
    '%s has a non-test consumer reference under apps/console/src, libs/work/src, or apps/runner-autoscaler/runner-image',
    (label) => {
      expect(consumerSource).toContain(label);
    },
  );
});
