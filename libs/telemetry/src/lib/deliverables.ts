import { collectStrings } from './unknown-value';

const PR_URL_PATTERN = /\/pull\/(\d+)/g;
const COMMIT_BRACKET_PATTERN = /\[[^\]\n]*?\s([0-9a-f]{7,40})\]/gi;
const DELIVERABLE_COMMAND_PATTERN = /\bgh\s+pr\s+create\b|\bgit\s+commit\b/i;

export interface DeliverablesFound {
  prNumbers: number[];
  commitShas: string[];
}

/**
 * True for a shell command that plausibly produces a PR link or commit
 * bracket output as its own result — i.e. one the agent ran to *create* a
 * deliverable, not merely to look one up (`gh pr list`, `gh issue view`,
 * etc. routinely echo unrelated PR URLs from other sessions/issues and must
 * not be scanned).
 */
export function isDeliverableCommand(command: string): boolean {
  return DELIVERABLE_COMMAND_PATTERN.test(command);
}

/**
 * Best-effort scan of textual content for PR links and `git commit` bracket
 * output (e.g. `[main a1b2c3d] message`). Heuristic — misses/false-negatives
 * are expected and acceptable for a summary tier. Scanning arbitrary
 * transcript text (tool inputs, unrelated command output) misattributes
 * PRs/commits the session never produced, so callers that can identify
 * which tool result actually came from a creating command (see
 * `isDeliverableCommand`) should scan only that result, not the whole line.
 */
export function findDeliverables(line: unknown): DeliverablesFound {
  const strings: string[] = [];
  collectStrings(line, strings);
  const text = strings.join('\n');

  const prNumbers = new Set<number>();
  for (const match of text.matchAll(PR_URL_PATTERN)) {
    prNumbers.add(Number(match[1]));
  }

  const commitShas = new Set<string>();
  for (const match of text.matchAll(COMMIT_BRACKET_PATTERN)) {
    commitShas.add(match[1]);
  }

  return {
    prNumbers: Array.from(prNumbers),
    commitShas: Array.from(commitShas),
  };
}
