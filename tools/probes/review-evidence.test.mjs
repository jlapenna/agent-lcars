import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateReview,
  completedOpenCodeChild,
  completedOpenCode2Child,
  antigravityChildIds,
} from './review-evidence.mjs';

function completedReview() {
  const head = '1'.repeat(40);
  const revision = '2'.repeat(40);
  const marker = '<!-- review-qualification:test -->';
  return {
    manifest: {
      reviewedHead: head,
      upstreamRevision: revision,
      marker,
      publication: 'captured-not-posted',
      environment: 'fixture',
    },
    execution: { exitCode: 0, timedOut: false },
    receipt: {
      head,
      complete: true,
      reviewers: ['guidance-a', 'guidance-b', 'bugs-a', 'bugs-b'].map(
        (role) => ({ role, nativeSessionId: 'native-' + role, complete: true }),
      ),
      candidates: [],
      validators: [],
    },
    payload: {
      commit_id: head,
      event: 'COMMENT',
      body: revision + '\n' + marker,
      comments: [],
    },
    native: {
      completedChildren: [
        'native-guidance-a',
        'native-guidance-b',
        'native-bugs-a',
        'native-bugs-b',
      ],
      errors: [],
    },
  };
}

test('a zero-finding review can pass with four observed completed native children', () => {
  assert.equal(evaluateReview(completedReview()).passed, true);
});

test('CLI exit zero cannot turn the observed incomplete replay into a pass', () => {
  const input = completedReview();
  input.receipt.complete = false;
  assert.equal(evaluateReview(input).passed, false);
});

test('a model-authored four-pass receipt is insufficient without native completion evidence', () => {
  const input = completedReview();
  input.native.completedChildren = [];
  assert.equal(evaluateReview(input).passed, false);
});

test('a missing fourth pass cannot be replaced by a duplicate completed reviewer', () => {
  const input = completedReview();
  input.receipt.reviewers[3] = input.receipt.reviewers[0];
  assert.equal(evaluateReview(input).passed, false);
});

test('every candidate requires an observed fresh validator, including rejected candidates', () => {
  const input = completedReview();
  input.receipt.candidates = [
    { id: 'candidate-1', path: 'renovate.json', line: 10 },
  ];
  assert.equal(evaluateReview(input).passed, false);
  input.receipt.validators = [
    {
      candidateId: 'candidate-1',
      nativeSessionId: 'native-bugs-a',
      decision: 'rejected',
      evidence: 'Checked the effective inherited configuration.',
    },
  ];
  assert.equal(evaluateReview(input).passed, false);
  input.receipt.validators[0].nativeSessionId = 'native-validator';
  assert.equal(evaluateReview(input).passed, false);
  input.native.completedChildren.push('native-validator');
  assert.equal(evaluateReview(input).passed, true);
});

test('publication at an unreviewed head cannot pass', () => {
  const input = completedReview();
  input.payload.commit_id = '3'.repeat(40);
  assert.equal(evaluateReview(input).passed, false);
});

test('a reviewer alias cannot masquerade as an independent validator', () => {
  const input = completedReview();
  input.receipt.candidates = [{ id: 'C1' }];
  input.receipt.validators = [
    {
      candidateId: 'C1',
      nativeSessionId: '/native/alias',
      decision: 'confirmed',
      evidence: 'Concrete source evidence.',
    },
  ];
  input.native.canonicalIds = { '/native/alias': 'native-bugs-a' };
  assert.equal(evaluateReview(input).passed, false);
});

test('empty validation evidence cannot pass', () => {
  const input = completedReview();
  input.receipt.candidates = [{ id: 'C1' }];
  input.receipt.validators = [
    {
      candidateId: 'C1',
      nativeSessionId: 'validator',
      decision: 'confirmed',
      evidence: [],
    },
  ];
  input.native.completedChildren.push('validator');
  assert.equal(evaluateReview(input).passed, false);
});

test('native collection errors cannot be hidden by a completed receipt', () => {
  const input = completedReview();
  input.native.errors.push('Missing child transcript');
  assert.equal(evaluateReview(input).passed, false);
});

function openCodeExport() {
  return {
    root: { info: { id: 'native-parent' } },
    task: {
      tool: 'task',
      state: {
        status: 'completed',
        metadata: {
          parentSessionId: 'native-parent',
          sessionId: 'native-child',
          truncated: false,
        },
      },
    },
    child: {
      info: { id: 'native-child', parentID: 'native-parent' },
      messages: [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'Review evidence.' }],
        },
      ],
    },
  };
}

test('OpenCode store exports retain a completed child when the live stream loses its task event', () => {
  const input = openCodeExport();
  assert.equal(
    completedOpenCodeChild(input.root, input.task, input.child),
    true,
  );
});

test('OpenCode cannot borrow a completed child from another native parent', () => {
  const input = openCodeExport();
  input.child.info.parentID = 'another-parent';
  assert.equal(
    completedOpenCodeChild(input.root, input.task, input.child),
    false,
  );
});

test('OpenCode background-start or unfinished exports are not completion proof', () => {
  const input = openCodeExport();
  input.task.state.metadata.background = true;
  assert.equal(
    completedOpenCodeChild(input.root, input.task, input.child),
    false,
  );
  delete input.task.state.metadata.background;
  input.child.messages[0].info.finish = 'tool-calls';
  assert.equal(
    completedOpenCodeChild(input.root, input.task, input.child),
    false,
  );
});

// Shapes captured from OpenCode v2.3.2 `session export` of a parent that
// delegated to a background `subagent` child.
function openCode2Export() {
  const call = {
    type: 'tool',
    id: 'call_1',
    name: 'subagent',
    state: {
      status: 'completed',
      input: { agent: 'general', description: 'review', prompt: 'Review.' },
      metadata: {
        sessionID: 'ses_child',
        status: 'running',
        truncated: false,
      },
    },
  };
  return {
    call,
    root: {
      info: { id: 'ses_parent' },
      messages: [
        { type: 'user', text: 'Review the PR.' },
        { type: 'assistant', finish: 'tool-calls', content: [call] },
        { type: 'idle', outcome: 'succeeded' },
        {
          type: 'synthetic',
          text: '<subagent sessionID="ses_child" state="completed" description="review">\nReview evidence.\n</subagent>',
        },
        {
          type: 'assistant',
          finish: 'stop',
          content: [{ type: 'text', text: 'Done.' }],
        },
      ],
    },
    child: {
      info: { id: 'ses_child', parentID: 'ses_parent', outcome: 'succeeded' },
      messages: [
        { type: 'user', text: 'Review.' },
        {
          type: 'assistant',
          finish: 'stop',
          content: [{ type: 'text', text: 'Review evidence.' }],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    },
  };
}

test('OpenCode 2 background children complete through their own export and parent report', () => {
  const input = openCode2Export();
  assert.equal(
    completedOpenCode2Child(input.root, input.call, input.child),
    true,
  );
});

test('OpenCode 2 children need a native parent, a finished turn and the parent report', () => {
  for (const mutate of [
    (input) => (input.child.info.parentID = 'another-parent'),
    (input) => (input.child.info.outcome = 'failed'),
    (input) => (input.child.messages[1].finish = 'tool-calls'),
    (input) =>
      (input.child.messages[1].content = [{ type: 'text', text: ' ' }]),
    (input) => (input.call.state.metadata.sessionID = 'ses_other'),
    (input) => (input.call.state.metadata.truncated = true),
    (input) => input.root.messages.splice(3, 1),
  ]) {
    const input = openCode2Export();
    mutate(input);
    assert.equal(
      completedOpenCode2Child(input.root, input.call, input.child),
      false,
    );
  }
});

test('a review that mutated its source checkout cannot pass', () => {
  const input = completedReview();
  input.execution.sourceUnchanged = false;
  assert.ok(evaluateReview(input).failures.includes('review-source-changed'));
});

// Field names and nesting captured from native Antigravity 1.5.9 stream JSON.
function agySpawn(state = 'DONE') {
  return {
    step_update: {
      tool_name: 'invoke_subagent',
      state,
      subagent_info: {
        subagents: [
          {
            type_name: 'self',
            role: 'Guidance Reviewer A',
            conversation_id: '86866a02-80fd-455e-b17a-d5f647dda27c',
            initial_prompt: 'Review the immutable source.',
          },
        ],
      },
    },
  };
}

test('Antigravity registers a native spawned child without an optional listing', () => {
  assert.deepEqual(antigravityChildIds([agySpawn()]), [
    '86866a02-80fd-455e-b17a-d5f647dda27c',
  ]);
});

test('Antigravity deduplicates spawn and optional listing evidence', () => {
  const listing = {
    step_update: {
      tool_name: 'manage_subagents',
      state: 'DONE',
      tool_info: {
        output:
          '{"subagents":[{"conversationId": "86866a02-80fd-455e-b17a-d5f647dda27c"}]}',
      },
    },
  };
  assert.deepEqual(antigravityChildIds([listing]), [
    '86866a02-80fd-455e-b17a-d5f647dda27c',
  ]);
  assert.deepEqual(antigravityChildIds([agySpawn(), listing]), [
    '86866a02-80fd-455e-b17a-d5f647dda27c',
  ]);
});

test('Antigravity ignores uncommitted invocations, unrelated output and malformed IDs', () => {
  const wrongTool = agySpawn();
  wrongTool.step_update.tool_name = 'view_file';
  const invalid = agySpawn();
  invalid.step_update.subagent_info.subagents[0].conversation_id =
    '../../another-session';
  const outputOnly = {
    step_update: {
      tool_name: 'invoke_subagent',
      state: 'DONE',
      tool_info: {
        output: '{"conversationId":"86866a02-80fd-455e-b17a-d5f647dda27c"}',
      },
    },
  };
  assert.deepEqual(
    antigravityChildIds([agySpawn('ACTIVE'), wrongTool, invalid, outputOnly]),
    [],
  );
});
