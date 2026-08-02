import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Heuristic lint for docs/bot-identity-formats.md's core rule: a login
 * fetched from a GraphQL-backed `gh` field (`--json author`, `.author.login`
 * - `gh pr/issue list|view`'s JSON flags are GraphQL under the hood) comes
 * back as `app/{slug}`, while this repo's REST-shaped values
 * (`AGENT_BOT_LOGINS`, `AGENT_FLEET_LOGIN`, a literal `x[bot]`) are
 * `{slug}[bot]`. Comparing the two raw is exactly the bug that silently
 * broke #175 (see docs/bot-identity-formats.md's "Why the two shapes
 * exist"/"Decision" sections).
 *
 * This is NOT a real parser - it is a line-window heuristic:
 *  - Detects a GraphQL-author signal line (`--json ...author...` or
 *    `.author.login`) via regex against each workflow file's raw text.
 *  - Looks for a REST-shaped comparison signal (`AGENT_BOT_LOGINS`,
 *    `AGENT_FLEET_LOGIN`, a `[bot]` literal) within a fixed window of lines
 *    around it - a proxy for "the same step", chosen over parsing step
 *    boundaries out of the YAML to keep this simple.
 *  - If both are present, requires a normalization signal in the same
 *    window: either the documented `sed -E 's#^app/(.+)#\1[bot]#'` pattern,
 *    or the equivalent jq conditional already in use in this repo
 *    (`startswith("app/")` swapped for `[bot]` - see agent-automerge.yml's
 *    close-orphaned-anchors job), detected as "app/" and "[bot]" both
 *    appearing somewhere in the window.
 *
 * Known limitations (why this stays a heuristic, not a real check):
 *  - The GraphQL-signal regex only looks within a single line, so a
 *    `--json` flag list that line-wraps with `author` on a following line
 *    is not detected.
 *  - The line window is fixed-size, not step-aware - a normalization
 *    signal from a *different* step that happens to land inside the window
 *    of an unrelated raw comparison would false-negative (miss a real
 *    violation). In this repo's current handful of small workflow files
 *    that has not been observed; revisit with real step-boundary parsing if
 *    it ever produces a false negative in practice.
 *  - It only greps `.github/workflows/*.yml` (matching this contract's
 *    scope) - a violation inside a composite action under `.github/actions/`
 *    would not be caught.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowsDir = path.join(repoRoot, '.github/workflows');

const GRAPHQL_AUTHOR_SIGNAL_RE = /--json\s+[^\n]*\bauthor\b|\.author\.login\b/;
const REST_COMPARISON_SIGNAL_RE = /AGENT_BOT_LOGINS|AGENT_FLEET_LOGIN|\[bot\]/;
// Either the documented sed one-liner, or evidence (anywhere in the window)
// that both shapes' literal substrings are being handled together - covers
// the jq-conditional form actually used in agent-automerge.yml today
// without hardcoding to that one query shape.
const NORMALIZATION_SIGNAL_RE = /app\//;

const WINDOW_LINES_BEFORE = 10;
const WINDOW_LINES_AFTER = 20;

interface Violation {
  location: string;
  line: string;
  // Embedded in the violation object (rather than passed as a separate
  // `expect()` message - this repo's eslint config rejects that form, see
  // vitest/valid-expect) so vitest's default failure diff still surfaces
  // the fix pointer.
  seeDoc: 'docs/bot-identity-formats.md, section "Decision: standardize on REST shape"';
}

function findViolations(filePath: string, contents: string): Violation[] {
  const lines = contents.split('\n');
  const violations: Violation[] = [];

  lines.forEach((line, index) => {
    if (!GRAPHQL_AUTHOR_SIGNAL_RE.test(line)) return;

    const windowStart = Math.max(0, index - WINDOW_LINES_BEFORE);
    const windowEnd = Math.min(lines.length, index + WINDOW_LINES_AFTER + 1);
    const window = lines.slice(windowStart, windowEnd).join('\n');

    const comparesAgainstRestShape = REST_COMPARISON_SIGNAL_RE.test(window);
    if (!comparesAgainstRestShape) return; // Not compared to a REST-shaped value - safe per the doc.

    const normalizes =
      NORMALIZATION_SIGNAL_RE.test(window) && window.includes('[bot]');
    if (normalizes) return;

    violations.push({
      location: `${filePath}:${index + 1}`,
      line: line.trim(),
      seeDoc:
        'docs/bot-identity-formats.md, section "Decision: standardize on REST shape"',
    });
  });

  return violations;
}

describe('bot-identity shape contract (heuristic)', () => {
  const workflowFiles = readdirSync(workflowsDir).filter(
    (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
  );

  it('found at least one workflow file to scan', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)(
    '%s does not compare a raw GraphQL-shaped author login against a REST-shaped value',
    (fileName) => {
      const filePath = path.join(workflowsDir, fileName);
      const contents = readFileSync(filePath, 'utf8');
      const violations = findViolations(fileName, contents);

      // A raw GraphQL-shaped author login (`app/{slug}`) is being compared
      // against a REST-shaped value (AGENT_BOT_LOGINS/AGENT_FLEET_LOGIN/a
      // `[bot]` literal) without normalizing first - fix by normalizing with
      // the documented `sed -E 's#^app/(.+)#\1[bot]#'` pattern (or an
      // equivalent jq conditional) before comparing. See each violation's
      // `seeDoc` field below for the doc reference.
      expect(violations).toEqual([]);
    },
  );
});
