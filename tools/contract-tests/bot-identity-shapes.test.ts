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
 *  - Comment text is stripped first (see `stripComments`) so an
 *    *explanatory* comment mentioning "app/" or "[bot]" - like the one
 *    right above the real callsite this rule is modeled on, in
 *    agent-automerge-reusable.yml's close-orphaned-anchors job - can never stand in
 *    for the normalization it describes. Without this, a stale comment left
 *    behind after someone deleted the real normalization code would keep
 *    the check silently passing - the exact failure mode this whole test
 *    exists to prevent, just one level removed. See the
 *    "explanatory comment is not normalization" test below for the
 *    regression this guards.
 *  - Detects a GraphQL-author signal line (`--json ...author...` or
 *    `.author.login`) via regex against each workflow file's comment-
 *    stripped text.
 *  - Looks for a REST-shaped comparison signal (`AGENT_BOT_LOGINS`,
 *    `AGENT_FLEET_LOGIN`, a `[bot]` literal) within a fixed window of lines
 *    around it - a proxy for "the same step", chosen over parsing step
 *    boundaries out of the YAML to keep this simple.
 *  - If both are present, requires a normalization signal in the same
 *    window: either the documented `sed -E 's#^app/(.+)#\1[bot]#'` pattern,
 *    or the equivalent jq conditional already in use in this repo
 *    (`startswith("app/")` swapped for `[bot]` - see agent-automerge-reusable.yml's
 *    close-orphaned-anchors job), detected as "app/" and "[bot]" both
 *    appearing somewhere in the (comment-stripped) window.
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
 *  - `stripComments` tracks `'`/`"` quote state to avoid treating a `#`
 *    inside a string as a comment marker, but it is a per-line heuristic,
 *    not a real shell/YAML lexer - it does not understand escaped quotes
 *    (`\"`) or a quote that spans multiple lines (e.g. inside a `jq '...'`
 *    script broken across lines). Not observed to misfire on this repo's
 *    current workflow files.
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
// the jq-conditional form actually used in agent-automerge-reusable.yml today
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

/**
 * Blanks out comment text so it can never satisfy a signal/normalization
 * check on its own - a comment can describe the `app/`/`[bot]` shapes (or
 * even literally show `--json author` as an example) without any of that
 * code actually running. Preserves line count/position (comment-only lines
 * become empty strings; inline trailing comments are truncated in place)
 * so line numbers in reported violations stay accurate.
 *
 * A `#` only starts a comment when it is not inside a `'...'`/`"..."`
 * string - tracked per-line via a simple left-to-right quote-state scan
 * (see the "Known limitations" doc comment above this file's main comment
 * block for what this does not handle).
 */
function stripComments(contents: string): string {
  return contents
    .split('\n')
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) {
          inSingle = !inSingle;
        } else if (ch === '"' && !inSingle) {
          inDouble = !inDouble;
        } else if (ch === '#' && !inSingle && !inDouble) {
          // A `#` at the very start of the line, or preceded by whitespace,
          // is a comment marker (YAML/shell convention); a `#` glued to
          // preceding text (e.g. a URL fragment or issue reference like
          // `#175` used mid-sentence in code) is left alone since it is not
          // reliably a comment start.
          if (i === 0 || /\s/.test(line[i - 1])) {
            return line.slice(0, i);
          }
        }
      }
      return line;
    })
    .join('\n');
}

function findViolations(filePath: string, rawContents: string): Violation[] {
  const contents = stripComments(rawContents);
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

  // Fixtures below are hand-written, not read from the real workflow files -
  // these prove the *heuristic itself* (comment-stripping in particular)
  // behaves correctly, independent of what today's actual workflows happen
  // to contain.
  describe('comment-stripping (regression for a real review finding)', () => {
    // Modeled on agent-automerge-reusable.yml's close-orphaned-anchors job: an
    // explanatory comment describing the app/[bot] shapes, sitting directly
    // above the real callsite. Before comment-stripping was added, this
    // comment block alone was enough to satisfy the normalization check -
    // so deleting the actual `startswith("app/")` transform below while
    // leaving the comment in place went undetected.
    const EXPLANATORY_COMMENT = [
      '          # `gh pr list --json author` answers in the GRAPHQL shape',
      '          # (`app/claude`) while AGENT_BOT_LOGINS is REST-shaped',
      '          # (`claude[bot]`) - comparing them raw is exactly the silent',
      '          # mismatch that broke #175, and docs/bot-identity-formats.md makes',
      '          # REST canonical. Normalize before the membership test.',
    ].join('\n');

    it('flags a raw comparison when normalization code is missing but the explanatory comment remains', () => {
      const fixture = [
        '      - name: Close open anchors of recently-merged agent PRs',
        '        env:',
        "          AGENT_BOT_LOGINS: ${{ vars.AGENT_BOT_LOGINS || '[]' }}",
        '        run: |',
        EXPLANATORY_COMMENT,
        '          gh pr list --repo "$REPO" --state merged --limit 50 \\',
        '            --json number,author,mergedAt >/tmp/merged.json',
        '',
        // No `startswith("app/")` transform here - $raw (GraphQL-shaped) is
        // compared directly against $bots (REST-shaped AGENT_BOT_LOGINS).
        '          CANDIDATES=$(jq -r --argjson bots "$AGENT_BOT_LOGINS" \'',
        '            .[] | .author.login as $raw',
        '            | select($bots | index($raw) != null)',
        "          ' /tmp/merged.json)",
      ].join('\n');

      const violations = findViolations('fixture.yml', fixture);

      expect(violations.length).toBeGreaterThan(0);
    });

    it('does not flag the same shape when the real normalization code is present alongside the comment', () => {
      const fixture = [
        '      - name: Close open anchors of recently-merged agent PRs',
        '        env:',
        "          AGENT_BOT_LOGINS: ${{ vars.AGENT_BOT_LOGINS || '[]' }}",
        '        run: |',
        EXPLANATORY_COMMENT,
        '          gh pr list --repo "$REPO" --state merged --limit 50 \\',
        '            --json number,author,mergedAt >/tmp/merged.json',
        '',
        '          CANDIDATES=$(jq -r --argjson bots "$AGENT_BOT_LOGINS" \'',
        '            .[] | .author.login as $raw',
        '            | (if ($raw | startswith("app/")) then ($raw[4:] + "[bot]") else $raw end) as $login',
        '            | select($bots | index($login) != null)',
        "          ' /tmp/merged.json)",
      ].join('\n');

      const violations = findViolations('fixture.yml', fixture);

      expect(violations).toEqual([]);
    });

    it('does not let a comment alone (with no real usage at all) trigger a false positive', () => {
      const fixture = [
        '      - name: Unrelated step',
        '        run: |',
        EXPLANATORY_COMMENT,
        '          echo "just discussing the shapes, no gh call here"',
      ].join('\n');

      const violations = findViolations('fixture.yml', fixture);

      expect(violations).toEqual([]);
    });
  });
});
