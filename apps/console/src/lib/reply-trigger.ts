/**
 * Finds the first agent reply trigger in ordinary Markdown prose.
 *
 * GitHub-style mentions may appear anywhere on an unquoted prose line. Slash
 * commands remain commands: they must begin an unquoted line. Fenced code,
 * inline code, and blockquotes are inert so examples and quoted agent output
 * cannot redispatch work accidentally.
 */
export function matchReplyTrigger(
  body: string,
  triggers: readonly string[],
): string | undefined {
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let inlineCodeDelimiter = 0;

  for (const rawLine of body.split(/\r?\n/u)) {
    if (fence) {
      if (isClosingFence(rawLine, fence)) {
        fence = undefined;
      }
      continue;
    }

    const trimmed = rawLine.trimStart();
    if (inlineCodeDelimiter === 0) {
      const openingFence = fenceOpening(rawLine);
      if (openingFence) {
        fence = openingFence;
        continue;
      }
    }
    if (trimmed.startsWith('>')) continue;

    const masked = maskInlineCode(rawLine, inlineCodeDelimiter);
    const prose = masked.prose;
    inlineCodeDelimiter = masked.delimiterLength;
    let firstMatch: { trigger: string; index: number } | undefined;

    for (const trigger of triggers) {
      if (!trigger) continue;
      const index = trigger.startsWith('@')
        ? mentionIndex(prose, trigger)
        : commandIndex(prose, trigger);
      if (index === undefined) continue;
      if (!firstMatch || index < firstMatch.index) {
        firstMatch = { trigger, index };
      }
    }

    if (firstMatch) return firstMatch.trigger;
  }

  return undefined;
}

function fenceOpening(
  line: string,
): { marker: '`' | '~'; length: number } | undefined {
  const indentation = line.match(/^ */u)?.[0].length ?? 0;
  if (indentation > 3) return undefined;

  const trimmed = line.slice(indentation);
  const marker = trimmed[0];
  if (marker !== '`' && marker !== '~') return undefined;

  let length = 0;
  while (trimmed[length] === marker) length += 1;
  if (length < 3) return undefined;
  if (marker === '`' && trimmed.slice(length).includes('`')) return undefined;
  return { marker, length };
}

function isClosingFence(
  line: string,
  fence: { marker: '`' | '~'; length: number },
): boolean {
  const indentation = line.match(/^ */u)?.[0].length ?? 0;
  if (indentation > 3) return false;

  const trimmed = line.slice(indentation);
  let length = 0;
  while (trimmed[length] === fence.marker) length += 1;
  return length >= fence.length && /^[ \t]*$/u.test(trimmed.slice(length));
}

/** Replaces inline-code spans with spaces so match indexes stay comparable. */
function maskInlineCode(
  line: string,
  initialDelimiterLength: number,
): { prose: string; delimiterLength: number } {
  let result = '';
  let delimiterLength = initialDelimiterLength;

  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      result += delimiterLength === 0 ? line[index] : ' ';
      index += 1;
      continue;
    }

    let runLength = 1;
    while (line[index + runLength] === '`') runLength += 1;
    result += ' '.repeat(runLength);
    if (delimiterLength === 0) delimiterLength = runLength;
    else if (runLength === delimiterLength) delimiterLength = 0;
    index += runLength;
  }

  return { prose: result, delimiterLength };
}

function commandIndex(line: string, trigger: string): number | undefined {
  const trimmed = line.trimStart();
  const lowerTrigger = trigger.toLowerCase();
  const lowerLine = trimmed.toLowerCase();
  if (!lowerLine.startsWith(lowerTrigger)) return undefined;

  const rest = trimmed.slice(trigger.length);
  return rest.length === 0 || /^\s/u.test(rest)
    ? line.length - trimmed.length
    : undefined;
}

function mentionIndex(line: string, trigger: string): number | undefined {
  const lowerLine = line.toLowerCase();
  const lowerTrigger = trigger.toLowerCase();
  let fromIndex = 0;

  while (fromIndex < lowerLine.length) {
    const index = lowerLine.indexOf(lowerTrigger, fromIndex);
    if (index === -1) return undefined;

    const before = line[index - 1];
    const after = line[index + trigger.length];
    if (mentionBoundary(before) && mentionBoundary(after)) return index;
    fromIndex = index + trigger.length;
  }

  return undefined;
}

function mentionBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    (!/[\p{L}\p{N}_-]/u.test(character) &&
      character !== '@' &&
      character !== '/')
  );
}
