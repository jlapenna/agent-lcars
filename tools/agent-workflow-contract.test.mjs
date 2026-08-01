/* eslint-disable vitest/no-import-node-test -- CI runs this contract test before installing workspace dependencies. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function workflow(name) {
  return readFileSync(`.github/workflows/${name}.yml`, 'utf8');
}

function namedStep(source, name) {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = source.indexOf('\n      - name: ', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

for (const worker of ['claude', 'codex', 'opencode']) {
  test(`${worker} failure parks with both durable human signals`, () => {
    const step = namedStep(workflow(worker), 'Report failure on the issue');

    assert.match(step, /ISSUE_NUM: \$\{\{/);
    assert.match(step, /REPO: \$\{\{ github\.repository \}\}/);
    assert.match(step, /MAINTAINER: \$\{\{/);
    assert.match(
      step,
      /gh api "repos\/\$REPO\/issues\/\$ISSUE_NUM\/labels"[\s\S]*labels\[\]=status:needs-human/,
    );
    assert.match(
      step,
      /gh api "repos\/\$REPO\/issues\/\$ISSUE_NUM\/assignees"[\s\S]*assignees\[\]=\$MAINTAINER/,
    );
    assert.doesNotMatch(step, /--remove-label|--remove-assignee/);
  });
}

test('OpenCode accepts one post-anchor bot artifact and rejects pickup-only state', () => {
  const source = workflow('opencode');
  const claim = source.indexOf(
    '      - name: Claim the issue as the agent fleet',
  );
  const setup = source.indexOf('      - name: Shared agent setup');
  const step = namedStep(source, 'Verify a deliverable exists');

  assert.ok(
    claim >= 0 && claim < setup,
    'pickup must precede the start anchor',
  );
  assert.match(step, /comments\?since=\$STARTED_AT/);
  const threshold = Number(step.match(/\$\{botcomments:-0\}" -ge (\d+)/)?.[1]);
  assert.equal(threshold, 1);

  const commentIsDeliverable = (postAnchorComments) =>
    postAnchorComments >= threshold;
  assert.equal(commentIsDeliverable(0), false, 'pickup-only run');
  assert.equal(commentIsDeliverable(1), true, 'pickup plus summary');
  assert.equal(commentIsDeliverable(1), true, 'reply summary');
});

test('OpenCode retains every non-comment deliverable path', () => {
  const step = namedStep(workflow('opencode'), 'Verify a deliverable exists');

  assert.match(step, /\$\{prs:-0\}" -gt 0/);
  assert.match(step, /\$closed_at" \\> "\$STARTED_AT/);
  assert.match(step, /\$labeled" = "true"/);

  const isDeliverable = ({
    pullRequests = 0,
    closedAfterAnchor = false,
    needsHuman = false,
    postAnchorBotComments = 0,
  }) =>
    pullRequests > 0 ||
    closedAfterAnchor ||
    needsHuman ||
    postAnchorBotComments >= 1;

  assert.equal(isDeliverable({ pullRequests: 1 }), true, 'PR');
  assert.equal(isDeliverable({ closedAfterAnchor: true }), true, 'close');
  assert.equal(isDeliverable({ needsHuman: true }), true, 'needs-human');
});
