import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
