import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import contextLifecycleV2 from '../agents/opencode/context-lifecycle/index.js';
import contextLifecycle from '../agents/opencode/context-lifecycle/v1.js';

const directory = await mkdtemp(join(tmpdir(), 'opencode-context-test-'));
try {
  const root = join(directory, 'AGENTS.md');
  await writeFile(root, 'AUTHORITATIVE ROOT\n');
  const hooks = await contextLifecycle();
  await hooks['experimental.chat.system.transform'](
    { sessionID: 'one' },
    {
      system: [
        `Native prompt\nInstructions from: ${root}\nAUTHORITATIVE ROOT\n\nOther system guidance`,
      ],
    },
  );
  const read = (id, content, instructions = '') => ({
    info: { id, role: 'assistant', sessionID: 'one' },
    parts: [
      {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/worktree/source.ts', offset: 1, limit: 500 },
          metadata: {
            loaded: instructions
              ? ['/worktree/AGENTS.md', '/worktree/app/AGENTS.md']
              : [],
          },
          output:
            content +
            (instructions
              ? `\n\n<system-reminder>\n${instructions}\n</system-reminder>`
              : ''),
        },
      },
    ],
  });
  const duplicate =
    'Instructions from: /worktree/AGENTS.md\nAUTHORITATIVE ROOT\n';
  const child = 'Instructions from: /worktree/app/AGENTS.md\nUNIQUE CHILD RULE';
  const archived = read(
    'old',
    'OLD SOURCE'.repeat(20000),
    duplicate + '\n\n' + child,
  );
  const original = structuredClone(archived);
  const messages = [
    archived,
    read('recent1', 'RECENT ONE'.repeat(20000)),
    read('recent2', 'RECENT TWO'),
  ];
  await hooks['experimental.chat.messages.transform']({}, { messages });
  assert(!messages[0].parts[0].state.output.includes('OLD SOURCE'));
  assert(
    messages[0].parts[0].state.output.includes('retained in session history'),
  );
  assert(!messages[0].parts[0].state.output.includes('AUTHORITATIVE ROOT'));
  assert(messages[0].parts[0].state.output.includes('UNIQUE CHILD RULE'));
  assert(messages[1].parts[0].state.output.includes('RECENT ONE'));
  assert.equal(messages[2].parts[0].state.input.limit, 500);
  assert(original.parts[0].state.output.includes('OLD SOURCE'));

  // Required protocol documents, dispatch briefs, and working notes must
  // not be sacrificed to the source-code history budget.
  const protocol = read('protocol', 'REQUIRED PROTOCOL'.repeat(20000));
  protocol.parts[0].state.input.filePath = '/protocol/agent-protocol.md';
  const brief = read('brief', 'DISPATCH BRIEF'.repeat(20000));
  brief.parts[0].state.input.filePath = '/dispatch/context.json';
  const protectedMessages = [
    protocol,
    brief,
    read('new1', 'NEW'.repeat(40000)),
    read('new2', 'NEW'),
  ];
  await hooks['experimental.chat.messages.transform'](
    {},
    { messages: protectedMessages },
  );
  assert(
    protectedMessages[0].parts[0].state.output.includes('REQUIRED PROTOCOL'),
  );
  assert(protectedMessages[1].parts[0].state.output.includes('DISPATCH BRIEF'));

  // A summary request has no root system instructions; continuation still
  // deduplicates a newly loaded root copy without deleting a scoped override.
  await hooks['experimental.chat.system.transform'](
    { sessionID: 'one' },
    { system: ['Summary system'] },
  );
  const continuation = [
    read('after-summary', 'SOURCE', duplicate + '\n\n' + child),
  ];
  await hooks['experimental.chat.messages.transform'](
    {},
    { messages: continuation },
  );
  assert(!continuation[0].parts[0].state.output.includes('AUTHORITATIVE ROOT'));
  assert(continuation[0].parts[0].state.output.includes('UNIQUE CHILD RULE'));

  // Prefix matches, different sessions, and changed root files must retain
  // their instructions. A changed worktree copy is not an equivalent root.
  const changedCopy = [
    read('changed-copy', 'SOURCE', duplicate + 'EXTRA RULE'),
  ];
  await hooks['experimental.chat.messages.transform'](
    {},
    { messages: changedCopy },
  );
  assert(
    changedCopy[0].parts[0].state.output.includes(
      'AUTHORITATIVE ROOT\nEXTRA RULE',
    ),
  );
  const otherSession = [read('other', 'SOURCE', duplicate)];
  otherSession[0].info.sessionID = 'two';
  await hooks['experimental.chat.messages.transform'](
    {},
    { messages: otherSession },
  );
  assert(otherSession[0].parts[0].state.output.includes('AUTHORITATIVE ROOT'));
  await writeFile(root, 'UPDATED ROOT');
  const changedRoot = [read('changed-root', 'SOURCE', duplicate)];
  await hooks['experimental.chat.messages.transform'](
    {},
    { messages: changedRoot },
  );
  assert(changedRoot[0].parts[0].state.output.includes('AUTHORITATIVE ROOT'));

  const working = { maxOutputTokens: 8192 };
  await hooks['chat.params']({ agent: 'build' }, working);
  assert.equal(working.maxOutputTokens, 8192);
  await hooks['chat.params']({ agent: 'compaction' }, working);
  assert.equal(working.maxOutputTokens, 4096);
  const smaller = { maxOutputTokens: 1000 };
  await hooks['chat.params']({ agent: 'compaction' }, smaller);
  assert.equal(smaller.maxOutputTokens, 1000);
  const summary = { context: ['existing context'] };
  await hooks['experimental.session.compacting']({}, summary);
  assert.equal(summary.context[0], 'existing context');
  assert(summary.context[1].includes('next concrete action'));
  assert.equal(summary.prompt, undefined);

  // Exercise the OpenCode 2 `setup(ctx)` context + compaction + delete hooks.
  await writeFile(root, 'AUTHORITATIVE V2 ROOT\n');
  const registered = new Map();
  const v2Cleanup = await contextLifecycleV2.setup({
    session: {
      hook: (name, fn) => registered.set(name, fn),
    },
    event: {
      subscribe: async function* () {
        // Keep idle in unit fixture.
      },
    },
  });
  const v2ReadPair = (id, filePath, content) => [
    {
      id: `asst_${id}`,
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: `call_${id}`,
          name: 'read',
          input: { path: filePath, offset: 1, limit: 200 },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: `call_${id}`,
          name: 'read',
          result: { type: 'text', value: content },
        },
      ],
    },
  ];
  const v2Messages = [
    { role: 'user', content: [{ type: 'text', text: 'Start task' }] },
    ...v2ReadPair('old', '/worktree/source.ts', 'OLD V2 SOURCE'.repeat(20000)),
    {
      role: 'user',
      metadata: {
        instruction: {
          paths: ['/worktree/app/AGENTS.md', '/worktree/AGENTS.md'],
        },
      },
      content: [
        {
          type: 'text',
          text: 'Instructions from: /worktree/app/AGENTS.md\nUNIQUE V2 CHILD\n\n\nInstructions from: /worktree/AGENTS.md\nAUTHORITATIVE V2 ROOT\n',
        },
      ],
    },
    ...v2ReadPair(
      'protocol',
      '/protocol/agent-protocol.md',
      'KEEP MD'.repeat(20000),
    ),
    ...v2ReadPair('recent1', '/worktree/recent1.ts', 'RECENT1'.repeat(20000)),
    ...v2ReadPair('recent2', '/worktree/recent2.ts', 'RECENT2'),
  ];
  await registered.get('context')({
    sessionID: 'v2-ses',
    system: [
      {
        type: 'text',
        text: `System header\nInstructions from: ${root}\nAUTHORITATIVE V2 ROOT\n`,
      },
    ],
    messages: v2Messages,
    options: {},
  });
  assert(
    !v2Messages[2].content[0].result.value.includes('OLD V2 SOURCE'),
    'old source read should be evicted on v2',
  );
  assert(
    v2Messages[2].content[0].result.value.includes(
      'retained in session history',
    ),
  );
  assert(
    !v2Messages[3].content[0].text.includes('AUTHORITATIVE V2 ROOT'),
    'duplicate root instructions should be stripped from synthetic message on v2',
  );
  assert(v2Messages[3].content[0].text.includes('UNIQUE V2 CHILD'));
  assert(v2Messages[5].content[0].result.value.includes('KEEP MD'));
  assert(v2Messages[7].content[0].result.value.includes('RECENT1'));

  const v2Compaction = {
    sessionID: 'v2-ses',
    system: [{ type: 'text', text: 'Summarizer' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<template>' }] },
    ],
    options: { maxTokens: 8192 },
  };
  await registered.get('compaction')(v2Compaction);
  assert.equal(v2Compaction.options.maxTokens, 4096);
  assert(
    JSON.stringify(v2Compaction.messages).includes('next concrete action'),
  );
  v2Cleanup?.();

  console.log(
    'OpenCode request context: instruction identity, continuation, history retention, and summary budget OK',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
