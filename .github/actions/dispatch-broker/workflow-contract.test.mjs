import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const workflowsDirectory = path.resolve('.github/workflows');
const brokerPrefix = 'agent-lcars-dispatch-v1-';
const expectedGroup = '${{ needs.normalize.outputs.group }}';

async function workflowSources() {
  const names = (await fs.readdir(workflowsDirectory)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await fs.readFile(path.join(workflowsDirectory, name), 'utf8'),
    })),
  );
}

function concurrencyGroups(source) {
  return source.split(/\r?\n/gu).flatMap((line) => {
    const match = /^\s*group:\s*['"]?(.+?)['"]?\s*$/u.exec(line);
    return match ? [match[1]] : [];
  });
}

test('no other workflow declares the broker reserved namespace', async () => {
  const occurrences = [];
  for (const workflow of await workflowSources()) {
    for (const group of concurrencyGroups(workflow.source)) {
      if (group.toLowerCase().includes(brokerPrefix)) {
        occurrences.push({ name: workflow.name, group });
      }
    }
  }
  assert.deepEqual(occurrences, []);
});

test('queue max is paired with noncancelling serialized execution only', async () => {
  for (const workflow of await workflowSources()) {
    const queues = [
      ...workflow.source.matchAll(/^\s*queue:\s*(\S+)\s*$/gmu),
    ].map((match) => match[1]);
    assert.equal(
      queues.every((queue) => ['single', 'max'].includes(queue)),
      true,
      `${workflow.name} declares an unsupported queue policy`,
    );
    if (['agent-router.yml', 'codex.yml'].includes(workflow.name)) {
      assert.deepEqual(queues, ['max']);
      assert.match(workflow.source, /^\s*cancel-in-progress:\s*false\s*$/mu);
    } else {
      assert.equal(
        queues.length,
        0,
        `${workflow.name} unexpectedly declares a queue policy`,
      );
    }
  }
});

test('workers are dispatch-only and cannot subscribe directly to issue events', async () => {
  const sources = await workflowSources();
  for (const worker of ['claude.yml', 'codex.yml', 'opencode.yml']) {
    const source = sources.find(
      (candidate) => candidate.name === worker,
    )?.source;
    assert.ok(source, `${worker} is missing`);
    assert.doesNotMatch(source, /^\s+(issues|issue_comment):\s*$/mu);
  }
});

test('router serializes issue and pull-request lifecycle through one normalized group output', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  assert.ok(source.includes(`group: ${expectedGroup}`));
  assert.match(
    source,
    /^\s+group:\s+\$\{\{ steps\.normalize\.outputs\.group \}\}\s*$/mu,
  );
  assert.match(source, /^\s+pull_request:\s*$/mu);
  assert.match(source, /^\s+types:\s+\[closed, reopened\]\s*$/mu);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failures > 0) process.exitCode = 1;
