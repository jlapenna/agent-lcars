import { isCanonicalSessionRepository, type QualifiedSessionPR } from './types';
import { collectStrings } from './unknown-value';

const PR_URL_PATTERN = /\/pull\/(\d+)/g;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
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
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const openingBracket = text.indexOf('[', searchFrom);
    if (openingBracket === -1) break;
    const closingBracket = text.indexOf(']', openingBracket + 1);
    if (closingBracket === -1) break;

    const bracketContents = text.slice(openingBracket + 1, closingBracket);
    const parts = bracketContents.trim().split(/\s+/);
    const candidate = parts.length > 1 ? parts.at(-1) : undefined;
    if (candidate && COMMIT_SHA_PATTERN.test(candidate)) {
      commitShas.add(candidate);
    }
    searchFrom = closingBracket + 1;
  }

  return {
    prNumbers: Array.from(prNumbers),
    commitShas: Array.from(commitShas),
  };
}

/** Preserve the URL's repository. Call only on a correlated creating-command
 * result, never arbitrary user/assistant transcript text. */
export function findQualifiedPRs(line: unknown): QualifiedSessionPR[] {
  const strings: string[] = [];
  collectStrings(line, strings);
  const refs = new Map<string, QualifiedSessionPR>();
  const pattern =
    /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9][0-9]*)(?=[/?#\s"'`]|$)/gu;
  for (const text of strings)
    for (const match of text.matchAll(pattern)) {
      const repo = {
        owner: match[1],
        name: match[2],
      };
      const number = Number(match[3]);
      if (!isCanonicalSessionRepository(repo) || !Number.isSafeInteger(number))
        continue;
      refs.set(
        `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${number}`,
        { repo, number },
      );
    }
  return [...refs.values()];
}

export function isPRPublicationCommand(command: string): boolean {
  const words = literalShellWords(command);
  if (words === undefined) return false;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? '')) words.shift();
  if (words[0] === 'env') {
    words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? '')) words.shift();
  }
  if (words[0] === 'command') words.shift();
  if (
    !/^(?:[^\s]*\/)?gh$/u.test(words[0] ?? '') ||
    words[1] !== 'pr' ||
    words[2] !== 'create'
  )
    return false;

  // Values such as --title '--dry-run' are data, not CLI options.
  const valueFlags = new Set([
    '--title',
    '-t',
    '--body',
    '-b',
    '--body-file',
    '-F',
    '--base',
    '-B',
    '--head',
    '-H',
    '--repo',
    '-R',
    '--label',
    '-l',
    '--assignee',
    '-a',
    '--reviewer',
    '-r',
    '--project',
    '-p',
    '--template',
    '-T',
    '--milestone',
    '-m',
    '--recover',
  ]);
  const booleanFlags = new Set([
    '--draft',
    '--editor',
    '--fill',
    '--fill-first',
    '--fill-verbose',
    '--no-maintainer-edit',
  ]);
  for (let index = 3; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith('--')) {
      const flag = word.split('=', 1)[0];
      if (valueFlags.has(flag)) {
        if (!word.includes('=') && ++index >= words.length) return false;
      } else if (!booleanFlags.has(flag)) return false;
      continue;
    }
    if (!word.startsWith('-') || word.length === 1) return false;
    // Cobra accepts combined shorthand flags (-dh means draft + help).
    // A value-taking flag consumes the remainder, so -t--help is title data.
    for (let shorthand = 1; shorthand < word.length; shorthand++) {
      const flag = `-${word[shorthand]}`;
      if (valueFlags.has(flag)) {
        if (shorthand === word.length - 1 && ++index >= words.length)
          return false;
        break;
      }
      if (!['d', 'e', 'f'].includes(word[shorthand])) return false;
      if (word[shorthand + 1] === '=') break;
    }
  }
  return true;
}

/** Parse one literal shell invocation without executing it. Financial
 * attribution leaves substitutions, scripts and compound output unqualified:
 * their aggregate stdout cannot be bound to a specific creating command. */
function literalShellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  let ended = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined) return undefined;
      if (next !== '\n') {
        word += next;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (char === quote) quote = undefined;
      else if (char === '$' || char === '`') return undefined;
      else word += char;
      continue;
    }
    if (char === '#' && !started) {
      while (index < command.length && command[index] !== '\n') index++;
      if (index === command.length) break;
    }
    if (/\s/u.test(command[index])) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      if (command[index] === '\n' && words.length > 0) ended = true;
      continue;
    }
    if (ended || ';|&<>$`(){}'.includes(char)) return undefined;
    started = true;
    if (char === "'" || char === '"') quote = char;
    else word += char;
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(word);
  return words;
}
