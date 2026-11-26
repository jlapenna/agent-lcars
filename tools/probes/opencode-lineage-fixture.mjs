import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import workerPolicy, {
  workerPolicyPluginV2,
} from '../../packages/fleet-tools/bin/worker-opencode-plugin.mjs';

function isV2Context(native) {
  return typeof native?.session?.create === 'function';
}

async function createBeforeCaller(native) {
  if (isV2Context(native)) {
    let before;
    await workerPolicyPluginV2.setup({
      ...native,
      tool: {
        hook: async (name, fn) => {
          if (name === 'execute.before') before = fn;
        },
      },
    });
    return (sessionID, command = 'echo lineage-probe') =>
      before({
        tool: 'shell',
        sessionID,
        id: 'lineage-probe',
        input: { command },
      });
  }
  const hooks = await workerPolicy(native);
  return (sessionID, command = 'echo lineage-probe') =>
    hooks['tool.execute.before'](
      { tool: 'bash', sessionID, callID: 'lineage-probe' },
      { args: { command } },
    );
}

async function createEmptySession(native, parentID, title) {
  if (isV2Context(native)) {
    const info = await native.session.create({
      ...(parentID ? { parentID } : {}),
      title,
    });
    assert.ok(info?.id);
    assert.equal(info.parentID, parentID);
    return info.id;
  }
  const response = await native.client.session.create({
    body: {
      ...(parentID ? { parentID } : {}),
      title,
    },
  });
  assert.ok(!response.error && response.data?.id);
  assert.equal(response.data.parentID, parentID);
  return response.data.id;
}

// Real pinned-runtime session API, empty metadata sessions only. This does not
// launch agents or claim end-to-end delegated tool execution qualification.
export async function probeLineage(native, root) {
  const action = await createBeforeCaller(native);
  await action(root);
  const bindingPath = `${process.env.LCARS_WORKER_CONTEXT}.session.json`;
  const before = readFileSync(bindingPath, 'utf8');
  const child = await createEmptySession(
    native,
    root,
    'LCARS empty lineage fixture',
  );
  const grandchild = await createEmptySession(
    native,
    child,
    'LCARS empty lineage fixture',
  );
  const unrelated = await createEmptySession(
    native,
    undefined,
    'LCARS empty lineage fixture',
  );
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
  const resumedAction = await createBeforeCaller(native);
  await resumedAction(child, 'echo lineage-probe');
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
  const initialAction = await createBeforeCaller(native);
  await initialAction(root, 'echo establish-root');
  const contextPath = process.env.LCARS_WORKER_CONTEXT;
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  const binding = readFileSync(`${contextPath}.session.json`, 'utf8');
  const work = `${contextPath}.preserved-work`;
  writeFileSync(work, 'uncommitted fixture work');
  const childId = await createEmptySession(
    native,
    root,
    'LCARS empty recovery fixture',
  );
  let reads = 0;
  const faultyNative = isV2Context(native)
    ? {
        ...native,
        session: {
          ...native.session,
          get: async (input, options) => {
            reads++;
            if (reads === 1 || exhausted)
              throw new Error('Injected native session API outage');
            return native.session.get(input, options);
          },
        },
      }
    : {
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
      };
  const faultyAction = await createBeforeCaller(faultyNative);
  const action = faultyAction(childId, 'echo recovered-lineage');
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
