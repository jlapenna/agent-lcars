import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateReview, completedOpenCodeChild } from './review-evidence.mjs';

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

test('a review that mutated its source checkout cannot pass', () => {
  const input = completedReview();
  input.execution.sourceUnchanged = false;
  assert.ok(evaluateReview(input).failures.includes('review-source-changed'));
});
