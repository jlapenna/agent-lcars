import { findQualifiedPRs, isPRPublicationCommand } from './deliverables';
import type { QualifiedSessionPR } from './types';
import { asArray, asRecord, asString } from './unknown-value';

export interface CodexInvocation {
  tool: 'exec_command' | 'write_stdin';
  args: Record<string, unknown>;
}

/** Recognize one transparent literal invocation, never evaluate orchestration
 * source. Additional statements, bindings, computed properties, printing,
 * control flow and dynamic arguments cannot prove output ownership. */
export function codeModeInvocation(
  input: unknown,
): CodexInvocation | undefined {
  if (typeof input !== 'string' || input.length > 100_000) return undefined;
  try {
    // Only code-mode publication evidence needs the parser. Keep the literal
    // require visible to bundlers, while native Node ESM resolves from this module.
    const parser: typeof import('acorn') =
      typeof require === 'function'
        ? /* eslint-disable-next-line no-restricted-syntax -- literal synchronous load keeps Acorn bundled; native ESM uses the fallback below */
          require('acorn')
        : process.getBuiltinModule('module').createRequire(import.meta.url)(
            'acorn',
          );
    const program = parser.parse(input, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    });
    if (program.body.length !== 1) return undefined;
    const statement = asRecord(program.body[0]);
    const outer = asRecord(statement?.['expression']);
    const callee = asRecord(outer?.['callee']);
    const args = asArray(outer?.['arguments']);
    if (
      statement?.['type'] !== 'ExpressionStatement' ||
      outer?.['type'] !== 'CallExpression' ||
      outer['optional'] ||
      callee?.['type'] !== 'Identifier' ||
      callee['name'] !== 'text' ||
      args?.length !== 1
    )
      return undefined;
    const awaited = asRecord(args[0]);
    const invocation = asRecord(awaited?.['argument']);
    const member = asRecord(invocation?.['callee']);
    const object = asRecord(member?.['object']);
    const property = asRecord(member?.['property']);
    const tool = property?.['name'];
    const toolArgs = asArray(invocation?.['arguments']);
    const literal = asRecord(toolArgs?.[0]);
    if (
      awaited?.['type'] !== 'AwaitExpression' ||
      invocation?.['type'] !== 'CallExpression' ||
      invocation['optional'] ||
      member?.['type'] !== 'MemberExpression' ||
      member['computed'] ||
      member['optional'] ||
      object?.['type'] !== 'Identifier' ||
      object['name'] !== 'tools' ||
      property?.['type'] !== 'Identifier' ||
      (tool !== 'exec_command' && tool !== 'write_stdin') ||
      toolArgs?.length !== 1 ||
      literal?.['type'] !== 'ObjectExpression'
    )
      return undefined;
    const values: Record<string, unknown> = Object.create(null);
    for (const raw of asArray(literal['properties']) ?? []) {
      const field = asRecord(raw);
      const key = asRecord(field?.['key']);
      const value = asRecord(field?.['value']);
      const name =
        key?.['type'] === 'Identifier'
          ? asString(key['name'])
          : asString(key?.['value']);
      if (
        field?.['type'] !== 'Property' ||
        field['computed'] ||
        field['method'] ||
        field['shorthand'] ||
        field['kind'] !== 'init' ||
        !name ||
        name in values ||
        value?.['type'] !== 'Literal' ||
        value['regex'] ||
        (!['string', 'number', 'boolean'].includes(typeof value['value']) &&
          value['value'] !== null)
      )
        return undefined;
      values[name] = value['value'];
    }
    return { tool, args: values };
  } catch {
    return undefined;
  }
}

export interface CodexExecResult {
  output: string;
  exitCode?: number;
  sessionId?: number;
}

/** The actual transport splits its fixed header and one JSON envelope across input_text blocks.
 * Reject aggregate envelopes instead of guessing which nested call printed it. */
export function codeModeResult(value: unknown): CodexExecResult | undefined {
  const direct = asString(value);
  const texts: string[] = [];
  if (direct !== undefined) texts.push(direct);
  else {
    const blocks = asArray(value);
    if (!blocks?.length) return undefined;
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (block?.['type'] !== 'input_text' && block?.['type'] !== 'text')
        return undefined;
      const text = asString(block['text']);
      if (text === undefined) return undefined;
      texts.push(text);
    }
  }
  const results: Record<string, unknown>[] = [];
  const prose: string[] = [];
  for (const text of texts) {
    let whole: unknown;
    try {
      whole = JSON.parse(text);
    } catch {
      /* Transport header plus envelope. */
    }
    const envelope = asRecord(whole);
    if (envelope && 'output' in envelope) {
      results.push(envelope);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = asRecord(JSON.parse(line));
        if (!parsed || !('output' in parsed)) return undefined;
        results.push(parsed);
      } catch {
        prose.push(line.trim());
      }
    }
  }
  // The producer emits the header and envelope as separate input_text blocks.
  // One fixed transport header is safe; arbitrary quoted fixture/prose blocks
  // and multiple JSON envelopes cannot establish single-call ownership.
  if (
    prose.length &&
    !/^Script completed\n(?:Wall time [0-9]+(?:\.[0-9]+)? seconds\n)?Output:$/u.test(
      prose.join('\n'),
    )
  )
    return undefined;
  if (results.length !== 1) return undefined;
  const result = results[0];
  const output = asString(result['output']);
  const exitCode = result['exit_code'];
  const sessionId = result['session_id'];
  if (
    output === undefined ||
    (exitCode !== undefined &&
      (!Number.isInteger(exitCode) || typeof exitCode !== 'number')) ||
    (sessionId !== undefined &&
      (typeof sessionId !== 'number' ||
        !Number.isSafeInteger(sessionId) ||
        sessionId <= 0))
  )
    return undefined;
  if (exitCode === undefined && sessionId === undefined) return undefined;
  return {
    output,
    exitCode: exitCode as number | undefined,
    sessionId: sessionId as number | undefined,
  };
}

/** The observed publication shell prefix reads Git identity. These specific
 * reads cannot emit fixture URLs; arbitrary compound shell remains excluded. */
export function codeModePublication(command: unknown): number | undefined {
  if (typeof command !== 'string') return undefined;
  let remainder = command.trim();
  let identityReads = 0;
  const identityPrefix =
    /^[ \t]*git[ \t]+(?:config[ \t]+(?:--get[ \t]+)?user\.(?:name|email)|var[ \t]+GIT_(?:AUTHOR|COMMITTER)_IDENT)[ \t]*(?:&&|;|\n)[ \t\r\n]*/u;
  while (identityReads < 2) {
    const prefix = identityPrefix.exec(remainder);
    if (!prefix) break;
    remainder = remainder.slice(prefix[0].length);
    identityReads++;
  }
  return isPRPublicationCommand(remainder) ? identityReads : undefined;
}

/** Only standalone gh's publication URL is financial evidence. Quoted URLs,
 * multiple identities and unrelated prose are retained as display hints. */
export function codeModePublishedPR(
  output: string,
  identityReads: number,
): QualifiedSessionPR | undefined {
  const lines = output.trim().split('\n');
  const url = lines.pop();
  if (
    !url ||
    lines.length > identityReads ||
    lines.some((line) => line.includes('https://'))
  )
    return undefined;
  if (
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*$/u.test(url)
  )
    return undefined;
  return findQualifiedPRs(url)[0];
}
