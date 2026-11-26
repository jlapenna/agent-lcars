import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Schema captured from the pinned 0.169.0 native CLI reproduction: v1 uses
// agent_id + fork_context:false and null agent_path. V2 uses task paths.
function collect(format, mutation) {
  const root = mkdtempSync(join(tmpdir(), 'lcars-review-native-'));
  try {
    const home = join(root, 'home');
    const sessions = join(home, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const id = randomUUID();
    const head = '1'.repeat(40),
      upstream = '2'.repeat(40),
      marker = '<!-- native fixture -->';
    const roles = ['guardrails', 'bugs'];
    const reviewers = roles.map((role) => ({
      role,
      nativeSessionId: randomUUID(),
      complete: true,
    }));
    const rootEvents = [];
    const json = (path, value) => writeFileSync(path, JSON.stringify(value));
    const jsonl = (path, values) =>
      writeFileSync(
        path,
        values.map((value) => JSON.stringify(value)).join('\n') + '\n',
      );
    for (const [index, reviewer] of reviewers.entries()) {
      const path = '/root/' + reviewer.role;
      const args =
        format === 'v1' ? { fork_context: false } : { fork_turns: 'none' };
      if (mutation === 'inherited') {
        delete args.fork_context;
        delete args.fork_turns;
      }
      rootEvents.push(
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'spawn_agent',
            call_id: 'spawn-' + index,
            arguments: JSON.stringify(args),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'spawn-' + index,
            output: JSON.stringify(
              format === 'v1'
                ? {
                    agent_id: reviewer.nativeSessionId,
                    nickname: reviewer.role,
                  }
                : { task_name: path },
            ),
          },
        },
      );
      jsonl(join(sessions, reviewer.nativeSessionId + '.jsonl'), [
        {
          type: 'session_meta',
          payload: {
            id: reviewer.nativeSessionId,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id:
                    mutation === 'foreign' && index === 0 ? randomUUID() : id,
                  depth: 1,
                  agent_path: format === 'v1' ? null : path,
                },
              },
            },
            multi_agent_version: format,
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ]);
    }
    jsonl(join(sessions, id + '.jsonl'), rootEvents);
    jsonl(join(root, 'trace.jsonl'), [
      { type: 'thread.started', thread_id: id },
    ]);
    json(join(root, 'manifest.json'), {
      provider: 'codex',
      reviewedHead: head,
      upstreamRevision: upstream,
      marker,
      publication: 'captured-not-posted',
      environment: 'native-schema-fixture',
    });
    json(join(root, 'execution.json'), {
      exitCode: 0,
      timedOut: false,
      interrupted: false,
    });
    json(join(root, 'receipt.json'), {
      head,
      complete: true,
      reviewers,
      candidates: [],
      validators: [],
    });
    json(join(root, 'review.json'), {
      commit_id: head,
      event: 'COMMENT',
      body: upstream + marker,
      comments: [],
    });
    if (mutation === 'receipt-json')
      writeFileSync(join(root, 'receipt.json'), '{');
    if (mutation === 'receipt-null') json(join(root, 'receipt.json'), null);
    if (mutation === 'receipt-inventory')
      json(join(root, 'receipt.json'), { reviewers: {}, validators: [] });
    if (mutation === 'receipt-null-item')
      json(join(root, 'receipt.json'), { reviewers: [null], validators: [] });
    const execution = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./collect-review-evidence.mjs', import.meta.url),
        ),
        root,
      ],
      {
        env: { ...process.env, CODEX_HOME: home },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(execution.error, undefined);
    return {
      exit: execution.status,
      evaluation: JSON.parse(
        readFileSync(join(root, 'evaluation.json'), 'utf8'),
      ),
      native: JSON.parse(
        readFileSync(join(root, 'native-evidence.json'), 'utf8'),
      ),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mutation of [
  'receipt-json',
  'receipt-null',
  'receipt-inventory',
  'receipt-null-item',
]) {
  test(`Codex collection retains failing evidence for ${mutation}`, () => {
    const result = collect('v1', mutation);
    assert.equal(result.exit, 1);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.failures.length > 0);
    if (mutation === 'receipt-json')
      assert.ok(
        result.evaluation.failures.some((reason) =>
          reason.startsWith('missing-or-invalid-output'),
        ),
      );
    assert.ok(result.native.artifacts.includes('native/codex-root.jsonl'));
    if (mutation !== 'receipt-null-item')
      assert.ok(
        result.native.errors.some((reason) =>
          reason.startsWith('Invalid Codex receipt:'),
        ),
      );
  });
}

for (const format of ['v1', 'v2']) {
  test(`collects two completed isolated ${format} native children bound to this parent`, () => {
    const result = collect(format);
    assert.equal(result.exit, 0);
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.native.completedChildren.length, 2);
    assert.equal(result.native.isolatedChildren.length, 2);
  });
  test(`rejects an authentic ${format} child belonging to a different parent`, () => {
    const result = collect(format, 'foreign');
    assert.equal(result.exit, 1);
    assert.ok(
      result.native.errors.some((error) => error.includes('not bound')),
    );
  });
  test(`rejects ${format} children without observable fresh contexts`, () => {
    const result = collect(format, 'inherited');
    assert.equal(result.exit, 1);
    assert.ok(
      result.evaluation.failures.includes(
        'codex-child-context-is-not-observably-fresh',
      ),
    );
  });
}

// Reproduces the native 1.19.5 large-export boundary: stdout must be a regular
// file because the CLI can exit before a pipe drains. No inference is used.
test('retains large native OpenCode exports and repeated child task references', () => {
  const root = mkdtempSync(join(tmpdir(), 'lcars-review-opencode-export-'));
  try {
    const json = (path, value) => writeFileSync(path, JSON.stringify(value));
    const roles = ['guardrails', 'bugs'];
    const reviewers = roles.map((role, i) => ({
      role,
      nativeSessionId: 'ses_child' + i,
      complete: true,
    }));
    const head = '1'.repeat(40),
      upstream = '2'.repeat(40),
      marker = '<!-- native export -->';
    const parent = 'ses_parent';
    const exports = {
      [parent]: {
        info: { id: parent },
        padding: 'x'.repeat(500000),
        messages: [
          {
            parts: reviewers.map((child) => ({
              tool: 'task',
              state: {
                status: 'completed',
                metadata: {
                  parentSessionId: parent,
                  sessionId: child.nativeSessionId,
                  truncated: false,
                },
              },
            })),
          },
        ],
      },
    };
    for (const child of reviewers)
      exports[child.nativeSessionId] = {
        info: { id: child.nativeSessionId, parentID: parent },
        messages: [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'Completed review.' }],
          },
        ],
      };
    // A coordinator may continue a reviewer task: export its native session once.
    exports[parent].messages[0].parts.push(
      exports[parent].messages[0].parts[0],
    );
    json(join(root, 'exports.json'), exports);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'opencode'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.LCARS_TEST_EXPORT_FIXTURE, 'utf8'));
const [command, subcommand, mode, id] = process.argv.slice(2);
if (command !== 'session' || subcommand !== 'export' || mode !== '--standalone') process.exit(2);
process.stdout.write(JSON.stringify(data[id]));
process.exit(0);
`,
      { mode: 0o700 },
    );
    json(join(root, 'manifest.json'), {
      provider: 'opencode',
      reviewedHead: head,
      upstreamRevision: upstream,
      marker,
      publication: 'captured-not-posted',
      environment: 'native-export-fixture',
    });
    json(join(root, 'execution.json'), {
      exitCode: 0,
      timedOut: false,
      interrupted: false,
    });
    json(join(root, 'receipt.json'), {
      head,
      complete: true,
      reviewers,
      candidates: [],
      validators: [],
    });
    json(join(root, 'review.json'), {
      commit_id: head,
      event: 'COMMENT',
      body: upstream + marker,
      comments: [],
    });
    writeFileSync(
      join(root, 'trace.jsonl'),
      JSON.stringify({ sessionID: parent }) + '\n',
    );
    const execution = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./collect-review-evidence.mjs', import.meta.url),
        ),
        root,
      ],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          LCARS_TEST_EXPORT_FIXTURE: join(root, 'exports.json'),
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(execution.error, undefined);
    const result = JSON.parse(
      readFileSync(join(root, 'evaluation.json'), 'utf8'),
    );
    assert.equal(execution.status, 0, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.equal(
      JSON.parse(
        readFileSync(join(root, 'native/opencode-' + parent + '.json'), 'utf8'),
      ).padding.length,
      500000,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Native Claude project directories can have truncated/hashed opaque names.
// Session UUIDs, tool-result agent IDs and terminal transcripts bind evidence.
function collectClaude(mutation) {
  const root = mkdtempSync(join(tmpdir(), 'lcars-claude-project-'));
  try {
    const config = join(root, 'claude');
    const session = randomUUID();
    const projects = join(config, 'projects');
    const directory = join(
      projects,
      'opaque-' + 'x'.repeat(190),
      session,
      'subagents',
    );
    mkdirSync(directory, { recursive: true });
    const head = '1'.repeat(40),
      upstream = '2'.repeat(40),
      marker = '<!-- Claude native fixture -->';
    const reviewers = ['guardrails', 'bugs'].map((role, i) => ({
      role,
      nativeSessionId: 'a'.repeat(15) + i,
      complete: true,
    }));
    const json = (path, value) => writeFileSync(path, JSON.stringify(value));
    for (const reviewer of reviewers)
      writeFileSync(
        join(directory, 'agent-' + reviewer.nativeSessionId + '.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: { model: 'fixture', stop_reason: 'end_turn' },
        }) + '\n',
      );
    if (mutation === 'ambiguous')
      mkdirSync(join(projects, 'another-project', session, 'subagents'), {
        recursive: true,
      });
    const trace = [
      ...(mutation === 'missing-init'
        ? []
        : [
            {
              subtype: 'init',
              session_id: session,
              cwd: '/review/' + 'long-context/'.repeat(30),
            },
          ]),
      ...reviewers.flatMap((reviewer, index) => [
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_use',
                name:
                  mutation === 'unregistered-agent' && index === 0
                    ? 'Bash'
                    : 'Agent',
                id: 'agent-call-' + index,
              },
            ],
          },
        },
        {
          type: 'user',
          parent_tool_use_id: null,
          tool_use_result: { agentId: reviewer.nativeSessionId },
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'agent-call-' + index,
                content:
                  'agentId: ' +
                  reviewer.nativeSessionId +
                  (mutation === 'foreign-agent-text'
                    ? '\nQuoted agentId: deadbeef'
                    : ''),
              },
            ],
          },
        },
      ]),
      ...(mutation === 'foreign-sidechain'
        ? [
            {
              type: 'user',
              parent_tool_use_id: 'agent-call-0',
              tool_use_result: { agentId: 'deadbeef' },
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'child-read',
                    content: 'old agentId: deadbeef',
                  },
                ],
              },
            },
          ]
        : []),
      ...(mutation === 'foreign-bash'
        ? [
            {
              type: 'assistant',
              parent_tool_use_id: null,
              message: {
                content: [
                  { type: 'tool_use', name: 'Bash', id: 'parent-read' },
                ],
              },
            },
            {
              type: 'user',
              parent_tool_use_id: null,
              tool_use_result: { agentId: 'deadbeef' },
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'parent-read',
                    content: 'old agentId: deadbeef',
                  },
                ],
              },
            },
          ]
        : []),
    ];
    writeFileSync(
      join(root, 'trace.jsonl'),
      trace.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    json(join(root, 'manifest.json'), {
      provider: 'claude',
      reviewedHead: head,
      upstreamRevision: upstream,
      marker,
      publication: 'captured-not-posted',
      environment: 'native-project-fixture',
    });
    json(join(root, 'execution.json'), {
      exitCode: 0,
      timedOut: false,
      interrupted: false,
    });
    json(join(root, 'receipt.json'), {
      head,
      complete: true,
      reviewers,
      candidates: [],
      validators: [],
    });
    json(join(root, 'review.json'), {
      commit_id: head,
      event: 'COMMENT',
      body: upstream + marker,
      comments: [],
    });
    const execution = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./collect-review-evidence.mjs', import.meta.url),
        ),
        root,
      ],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: config },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(execution.error, undefined);
    return {
      exit: execution.status,
      evaluation: JSON.parse(
        readFileSync(join(root, 'evaluation.json'), 'utf8'),
      ),
      native: JSON.parse(
        readFileSync(join(root, 'native-evidence.json'), 'utf8'),
      ),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Claude binds two completed reviewers through an opaque project directory for a long cwd', () => {
  const result = collectClaude();
  assert.equal(result.exit, 0);
  assert.equal(result.evaluation.passed, true);
  assert.equal(result.native.completedChildren.length, 2);
});
for (const mutation of ['ambiguous', 'missing-init'])
  test(
    'Claude rejects ' +
      mutation +
      ' native parent binding with a recorded result',
    () => {
      const result = collectClaude(mutation);
      assert.equal(result.exit, 1);
      assert.equal(result.evaluation.passed, false);
      assert.ok(
        result.native.errors.some((message) =>
          message.includes('unique Claude native parent'),
        ),
      );
    },
  );

for (const mutation of [
  'foreign-sidechain',
  'foreign-bash',
  'foreign-agent-text',
])
  test('Claude ignores unrelated agent IDs in ' + mutation, () => {
    const result = collectClaude(mutation);
    assert.equal(result.exit, 0);
    assert.equal(result.native.errors.length, 0);
    assert.equal(result.native.completedChildren.length, 2);
  });
test('Claude requires a coordinator Agent call for native child identity', () => {
  const result = collectClaude('unregistered-agent');
  assert.equal(result.exit, 1);
  assert.equal(result.evaluation.passed, false);
  assert.equal(result.native.completedChildren.length, 1);
});
