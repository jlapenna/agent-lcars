import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import contextLifecycle from '../agents/opencode/context-lifecycle.js';

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
  console.log(
    'OpenCode request context: instruction identity, continuation, history retention, and summary budget OK',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
