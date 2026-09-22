import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import workerPolicy from '../../packages/fleet-tools/bin/worker-opencode-plugin.mjs';

// Real pinned-runtime session API, empty metadata sessions only. This does not
// launch agents or claim end-to-end delegated tool execution qualification.
export async function probeLineage(native, root) {
  const hooks = await workerPolicy(native);
  const action = (sessionID, command = 'echo lineage-probe') =>
    hooks['tool.execute.before'](
      { tool: 'bash', sessionID, callID: 'lineage-probe' },
      { args: { command } },
    );
  await action(root);
  const bindingPath = `${process.env.LCARS_WORKER_CONTEXT}.session.json`;
  const before = readFileSync(bindingPath, 'utf8');
  const create = async (parentID) => {
    const response = await native.client.session.create({
      body: {
        ...(parentID ? { parentID } : {}),
        title: 'LCARS empty lineage fixture',
      },
    });
    assert.ok(!response.error && response.data?.id);
    assert.equal(response.data.parentID, parentID);
    return response.data.id;
  };
  const child = await create(root);
  const grandchild = await create(child);
  const unrelated = await create();
  await action(grandchild);
  await action(child);
  await assert.rejects(
    action(child, 'git commit --no-verify -m bypass'),
    /Do not bypass Git hooks/,
  );
  await assert.rejects(
    action(unrelated),
    /Native session identity does not match/,
  );
  // A second adapter instance (as after resume) must reestablish ancestry.
  const resumed = await workerPolicy(native);
  await resumed['tool.execute.before'](
    { tool: 'bash', sessionID: child, callID: 'resumed-lineage' },
    { args: { command: 'echo lineage-probe' } },
  );
  assert.equal(readFileSync(bindingPath, 'utf8'), before);
  return {
    root,
    child,
    grandchild,
    unrelated,
    providerApiLineageVerified: true,
    nativeDelegatedExecution: false,
  };
}

export async function probeLineageRecovery(native, root, exhausted) {
  const initial = await workerPolicy(native);
  await initial['tool.execute.before'](
    { tool: 'bash', sessionID: root },
    { args: { command: 'echo establish-root' } },
  );
  const contextPath = process.env.LCARS_WORKER_CONTEXT;
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  const binding = readFileSync(`${contextPath}.session.json`, 'utf8');
  const work = `${contextPath}.preserved-work`;
  writeFileSync(work, 'uncommitted fixture work');
  const child = await native.client.session.create({
    body: { parentID: root, title: 'LCARS empty recovery fixture' },
  });
  assert.ok(!child.error && child.data?.id);
  let reads = 0;
  const hooks = await workerPolicy({
    ...native,
    client: {
      session: {
        get: async (options) => {
          reads++;
          if (reads === 1 || exhausted)
            throw new Error('Injected native session API outage');
          return native.client.session.get(options);
        },
      },
    },
  });
  const action = hooks['tool.execute.before'](
    { tool: 'bash', sessionID: child.data.id },
    { args: { command: 'echo recovered-lineage' } },
  );
  if (exhausted) await assert.rejects(action, /infrastructure failure/);
  else await action;
  assert.equal(reads, 2);
  assert.equal(
    readFileSync(`${contextPath}.recovery-used`, 'utf8'),
    context.attemptId,
  );
  assert.equal(existsSync(`${contextPath}.recovery-succeeded`), !exhausted);
  assert.equal(existsSync(`${contextPath}.control-failed`), exhausted);
  assert.equal(readFileSync(work, 'utf8'), 'uncommitted fixture work');
  assert.equal(readFileSync(`${contextPath}.session.json`, 'utf8'), binding);
  return {
    providerApiLineageVerified: true,
    nativeDelegatedExecution: false,
    reads,
    exhausted,
    preservedWork: true,
  };
}
