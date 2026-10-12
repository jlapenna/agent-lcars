import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { codexAdapter } from './codex-transcript-adapter';

const url = 'https://github.com/jlapenna/agent-lcars/pull/2460';
const unrelated = 'https://github.com/acme/fixture/pull/99';
const fixture = readFileSync(
  new URL('./fixtures/codex-delayed-publication.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const call = (id: string, tool: string, args: unknown) => ({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: id,
    input: `text(await tools.${tool}(${JSON.stringify(args)}));`,
  },
});
const output = (id: string, envelope: unknown) => ({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    call_id: id,
    output: [{ type: 'input_text', text: JSON.stringify(envelope) }],
  },
});
function reduce(rows: unknown[]) {
  return codexAdapter.reduce(rows.map((row) => JSON.stringify(row)))[0];
}
const unqualifiedExpected = {
  publication: undefined,
  tokens: {
    inputTokens: 80,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheCreationTokens: 0,
  },
  hasLegacyHint: true,
};
function unqualified(rows: unknown[]) {
  const summary = reduce(rows);
  return {
    publication: summary.deliverables.qualifiedPRs,
    tokens: summary.tokens,
    hasLegacyHint: summary.deliverables.prNumbers.includes(2460),
  };
}

describe('Codex code-mode publication ownership (#2461)', () => {
  it('qualifies the sanitized observed wrapper → input_text envelope → owned delayed result once', () => {
    const summary = reduce(fixture);
    expect(summary.deliverables.qualifiedPRs).toEqual([
      { repo: { owner: 'jlapenna', name: 'agent-lcars' }, number: 2460 },
    ]);
    expect(summary.toolCallCounts).toEqual({ exec: 3 });
    expect(summary.tokens.inputTokens).toBe(80);
  });
  it('qualifies immediate successful envelopes and deduplicates later creating commands', () => {
    const summary = reduce([
      ...fixture.slice(0, 2),
      call('create', 'exec_command', { cmd: 'gh pr create' }),
      output('create', { exit_code: 0, output: url }),
      call('another', 'exec_command', { cmd: 'gh pr create' }),
      output('another', { exit_code: 0, output: url }),
      output('another', { exit_code: 0, output: unrelated }),
    ]);
    expect(summary.deliverables.qualifiedPRs).toHaveLength(1);
  });
  it('waits across multiple owned running polls, ignoring their nonterminal URLs', () => {
    const summary = reduce([
      ...fixture.slice(0, 4),
      call('running', 'write_stdin', { session_id: 4508 }),
      output('running', { session_id: 4508, output: unrelated }),
      ...fixture.slice(4),
    ]);
    expect(summary.deliverables.qualifiedPRs).toEqual([
      { repo: { owner: 'jlapenna', name: 'agent-lcars' }, number: 2460 },
    ]);
  });
  it.each([
    'gh pr edit 2460',
    'gh pr view 2460',
    'gh pr create --help',
    'gh pr create --dry-run',
    'gh pr create -dh',
    'printf "%s" "gh pr create"',
    "rg 'gh pr create' /tmp/fixture",
    'echo https://github.com/acme/fixture/pull/99\ngh pr create',
  ])('keeps %s results as display hints', (cmd) => {
    expect(
      unqualified([
        ...fixture.slice(0, 2),
        call('create', 'exec_command', { cmd }),
        output('create', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it.each([
    'text("gh pr create");',
    'text(await tools.exec_command({cmd: "gh pr create"})); text("spoof");',
    'if (false) text(await tools.exec_command({cmd: "gh pr create"}));',
    'text(await tools.exec_command({cmd: "gh pr create", cmd: "gh pr view 2460"}));',
    'text(await tools.exec_command({cmd: "gh pr create", ...other}));',
    'text(await tools.exec_command({cmd: `gh pr create ${fixture}`}));',
    'text(await tools.exec_command({cmd: "gh pr create" + suffix}));',
    'text(await tools.exec_command({get cmd() { return "gh pr create"; }}));',
    'text(await tools["exec_command"]({cmd: "gh pr create"}));',
  ])('rejects ambiguous or spoofing orchestration: %s', (input) => {
    const invocation = call('create', 'exec_command', {});
    invocation.payload.input = input;
    expect(
      unqualified([
        ...fixture.slice(0, 2),
        invocation,
        output('create', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it.each([
    { exit_code: 1, output: url },
    { output: url },
    { exit_code: '0', output: url },
    { exit_code: 0, session_id: 7777, output: url },
    { exit_code: 0, output: `"${url}"` },
    { exit_code: 0, output: `fixture: ${url}` },
    { exit_code: 0, output: `${unrelated}\n${url}` },
  ])(
    'rejects failed, mismatched or ambiguous terminal result %j',
    (envelope) => {
      expect(
        unqualified([...fixture.slice(0, 5), output('poll', envelope)]),
      ).toEqual(unqualifiedExpected);
    },
  );
  it('rejects multiple envelopes across blocks or lines', () => {
    const result = output('poll', { exit_code: 0, output: url });
    result.payload.output.push({
      type: 'input_text',
      text: JSON.stringify({ exit_code: 0, output: unrelated }),
    });
    expect(unqualified([...fixture.slice(0, 5), result])).toEqual(
      unqualifiedExpected,
    );
    result.payload.output = [
      {
        type: 'input_text',
        text:
          JSON.stringify({ exit_code: 0, output: url }) +
          '\n' +
          JSON.stringify({ exit_code: 0, output: unrelated }),
      },
    ];
    expect(unqualified([...fixture.slice(0, 5), result])).toEqual(
      unqualifiedExpected,
    );
  });
  it('rejects arbitrary fixture text outside the single stdout envelope', () => {
    const result = output('poll', { exit_code: 0, output: url });
    result.payload.output.unshift({
      type: 'input_text',
      text: `fixture: ${unrelated}`,
    });
    expect(unqualified([...fixture.slice(0, 5), result])).toEqual(
      unqualifiedExpected,
    );
  });
  it('does not qualify failed results on replay or a fresh poll of a consumed session', () => {
    expect(
      unqualified([
        ...fixture.slice(0, 5),
        output('poll', { exit_code: 1, output: url }),
        output('poll', { exit_code: 0, output: url }),
        call('replay', 'write_stdin', { session_id: 4508 }),
        output('replay', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it('rejects unrelated call IDs, session IDs and nonempty stdin', () => {
    for (const args of [
      { session_id: 999 },
      { session_id: 4508, chars: 'echo spoof\n' },
    ])
      expect(
        unqualified([
          ...fixture.slice(0, 4),
          call('poll', 'write_stdin', args),
          output('poll', { exit_code: 0, output: url }),
        ]),
      ).toEqual(unqualifiedExpected);
    expect(
      unqualified([
        ...fixture.slice(0, 5),
        output('other', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it('rejects exec session collisions and overlapping polls', () => {
    expect(
      unqualified([
        ...fixture.slice(0, 4),
        call('lookup', 'exec_command', { cmd: 'gh pr view 2460' }),
        output('lookup', { session_id: 4508, output: '' }),
        ...fixture.slice(4),
      ]),
    ).toEqual(unqualifiedExpected);
    expect(
      unqualified([
        ...fixture.slice(0, 5),
        call('overlap', 'write_stdin', { session_id: 4508 }),
        output('poll', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it.each(['pending', 'polling'] as const)(
    'invalidates ownership after intervening stdin while %s',
    (phase) => {
      const before =
        phase === 'pending' ? fixture.slice(0, 4) : fixture.slice(0, 5);
      const after =
        phase === 'pending' ? fixture.slice(4, 6) : fixture.slice(5, 6);
      expect(
        unqualified([
          ...before,
          call('inject', 'write_stdin', {
            session_id: 4508,
            chars: 'echo spoof\n',
          }),
          ...after,
        ]),
      ).toEqual(unqualifiedExpected);
    },
  );
  it.each(['pending', 'polling'] as const)(
    'invalidates ownership after unsupported orchestration while %s',
    (phase) => {
      const unsafe = call('unsafe', 'exec_command', {});
      unsafe.payload.input =
        'await tools.write_stdin({session_id:4508, chars:"spoof"}); text("done");';
      const before =
        phase === 'pending' ? fixture.slice(0, 4) : fixture.slice(0, 5);
      const after =
        phase === 'pending' ? fixture.slice(4, 6) : fixture.slice(5, 6);
      expect(unqualified([...before, unsafe, ...after])).toEqual(
        unqualifiedExpected,
      );
    },
  );
  it('invalidates code-mode ownership after an intervening direct stdin call', () => {
    expect(
      unqualified([
        ...fixture.slice(0, 4),
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'direct',
            name: 'write_stdin',
            arguments: JSON.stringify({ session_id: 4508, chars: 'spoof' }),
          },
        },
        ...fixture.slice(4, 6),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it('rejects immediate terminal session IDs and invalidates their previous owners', () => {
    expect(
      unqualified([
        ...fixture.slice(0, 4),
        call('collision', 'exec_command', { cmd: 'gh pr create' }),
        output('collision', { session_id: 4508, exit_code: 0, output: url }),
        ...fixture.slice(4, 6),
      ]),
    ).toEqual(unqualifiedExpected);
    expect(
      unqualified([
        ...fixture.slice(0, 2),
        call('create', 'exec_command', { cmd: 'gh pr create' }),
        output('create', { session_id: 123, exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it('invalidates a repeated call ID before its first result can be misattributed', () => {
    expect(
      unqualified([
        ...fixture.slice(0, 2),
        call('create', 'exec_command', { cmd: 'gh pr create' }),
        call('create', 'exec_command', { cmd: 'gh pr view 2460' }),
        output('create', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
  it.each([
    'git config --get user.name && git config --get user.email && ',
    'git var GIT_AUTHOR_IDENT; git var GIT_COMMITTER_IDENT; ',
  ])('qualifies only literal identity-read prefixes: %s', (prefix) => {
    const summary = reduce([
      ...fixture.slice(0, 2),
      call('create', 'exec_command', { cmd: prefix + 'gh pr create' }),
      output('create', {
        exit_code: 0,
        output: 'Agent\nagent@example.invalid\n' + url,
      }),
    ]);
    expect(summary.deliverables.qualifiedPRs).toEqual([
      { repo: { owner: 'jlapenna', name: 'agent-lcars' }, number: 2460 },
    ]);
  });
  it.each([0, 1])(
    'decodes direct shell input_text envelopes without accepting failed exit %i',
    (exit_code) => {
      const summary = reduce([
        ...fixture.slice(0, 2),
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'direct',
            arguments: JSON.stringify({ cmd: 'gh pr create' }),
          },
        },
        output('direct', { exit_code, output: url }),
      ]);
      expect(summary.deliverables.qualifiedPRs).toEqual(
        exit_code === 0
          ? [{ repo: { owner: 'jlapenna', name: 'agent-lcars' }, number: 2460 }]
          : undefined,
      );
      expect(summary.deliverables.prNumbers).toContain(2460);
      expect(summary.tokens.inputTokens).toBe(80);
    },
  );
  it('cannot revive consumed call IDs or bind malformed results to a later replay', () => {
    expect(
      unqualified([
        ...fixture.slice(0, 5),
        output('poll', {}),
        output('poll', { exit_code: 0, output: url }),
        call('create', 'exec_command', { cmd: 'gh pr create' }),
        output('create', { exit_code: 0, output: url }),
      ]),
    ).toEqual(unqualifiedExpected);
  });
});
