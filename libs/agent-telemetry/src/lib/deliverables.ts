import { collectStrings } from './unknown-value';

const PR_URL_PATTERN = /\/pull\/(\d+)/g;
const COMMIT_BRACKET_PATTERN = /\[[^\]\n]*?\s([0-9a-f]{7,40})\]/gi;

export interface DeliverablesFound {
  prNumbers: number[];
  commitShas: string[];
}

/**
 * Best-effort scan of a transcript line's textual content for PR links and
 * `git commit` bracket output (e.g. `[main a1b2c3d] message`). Heuristic —
 * misses/false-negatives are expected and acceptable for a summary tier.
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
