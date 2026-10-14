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

/**
 * True when the command's own result is a `gh pr create` result. A chain of
 * `&&` / `;` / newline segments qualifies only when every segment before the
 * create is silent setup (see `isSilentSetup`) and the create is the last
 * segment: its exit status is then the command's, and nothing after it can
 * print another URL. Pipes, `||`, background jobs and redirections stay
 * unqualified because they can turn a failed create into a success, e.g.
 * `| tail -1` over gh's "already exists: <url>" names someone else's PR.
 */
export function isPRPublicationCommand(command: string): boolean {
  const segments = literalShellSegments(command);
  if (segments === undefined || segments.length === 0) return false;
  const create = segments.at(-1);
  if (create === undefined) return false;
  return (
    segments.slice(0, -1).every(isSilentSetup) && isPRCreateWords([...create])
  );
}

/** Setup that prints no PR URL: directory changes, assignments, exports and
 * the fail-fast `set` options. `set -x`/`-v` would echo the create's own
 * arguments (a body naming other PRs) and are excluded. */
function isSilentSetup(words: readonly string[]): boolean {
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
  if (words.every((word) => assignment.test(word))) return true;
  const [name, ...args] = words;
  if (name === 'cd' || name === 'pushd') return args.length <= 1;
  if (name === 'export')
    return args.every(
      (word) => assignment.test(word) || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word),
    );
  if (name === 'set')
    return args.every(
      (word) =>
        /^[-+][euo]+$/u.test(word) ||
        ['pipefail', 'errexit', 'nounset'].includes(word),
    );
  return false;
}

function isPRCreateWords(words: string[]): boolean {
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

/** A quoted body's `$(cat <<'EOF' … EOF)`: the heredoc's text, which a quoted
 * delimiter keeps literal, and where the substitution ends. An unquoted
 * delimiter expands its body, so it qualifies only without `$`, backticks or
 * backslashes. Anything else is not a literal argument. */
function heredocSubstitution(
  command: string,
  start: number,
): { text: string; end: number } | undefined {
  const head =
    /^\$\(cat[ \t]+<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*\n/u.exec(
      command.slice(start),
    );
  if (!head) return undefined;
  const tag = head[2] ?? head[3] ?? head[4] ?? '';
  const indent = head[1] === '-' ? '\t*' : '';
  const bodyStart = start + head[0].length;
  const tail = new RegExp(`^${indent}${tag}[ \t]*\n[ \t]*\\)`, 'u');
  for (
    let lineStart = bodyStart;
    lineStart <= command.length;
    lineStart = command.indexOf('\n', lineStart) + 1
  ) {
    const close = tail.exec(command.slice(lineStart));
    if (close) {
      const text = command.slice(bodyStart, Math.max(bodyStart, lineStart - 1));
      if (head[4] !== undefined && /[$`\\]/u.test(text)) return undefined;
      return { text, end: lineStart + close[0].length - 1 };
    }
    if (command.indexOf('\n', lineStart) === -1) break;
  }
  return undefined;
}

/** Parse literal shell without executing it, split at top-level `&&`, `;`
 * and newlines. Financial attribution leaves other substitutions, scripts,
 * pipes and redirections unparsed: their output cannot be bound to a
 * specific creating command. */
function literalShellSegments(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  // After `&&` the chain needs another command.
  let needOperand = false;
  const endWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const endSegment = (required: boolean): boolean => {
    endWord();
    if (words.length === 0) return !required;
    segments.push(words);
    words = [];
    needOperand = false;
    return true;
  };
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
      else if (char === '$') {
        const substitution = heredocSubstitution(command, index);
        if (substitution === undefined) return undefined;
        word += substitution.text;
        index = substitution.end;
      } else if (char === '`') return undefined;
      else word += char;
      continue;
    }
    if (char === '#' && !started) {
      while (index < command.length && command[index] !== '\n') index++;
      if (index === command.length) break;
    }
    const current = command[index];
    if (current === '\n' || current === ';') {
      // A separator with nothing before it (`;;`, a leading `;`) is not a
      // simple chain.
      if (!endSegment(current === ';')) return undefined;
      continue;
    }
    if (/\s/u.test(current)) {
      endWord();
      continue;
    }
    if (current === '&') {
      // `&&` only; a lone `&` backgrounds the command.
      if (command[index + 1] !== '&' || !endSegment(true)) return undefined;
      needOperand = true;
      index++;
      continue;
    }
    if ('|<>$`(){}'.includes(current)) return undefined;
    started = true;
    if (current === "'" || current === '"') quote = current;
    else word += current;
  }
  if (quote !== undefined) return undefined;
  endSegment(false);
  return needOperand ? undefined : segments;
}
