// Fault injection around the installed evaluator, after real setup succeeds.
// The native adapter and bridge still execute their production recovery path.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function workflowRecoveryFixture(directory, target, preserved, content) {
  const handler = join(directory, 'workflow-fault.cjs');
  const trace = join(directory, 'workflow-recovery.jsonl');
  const policy = realpathSync(
    resolve('packages/fleet-tools/bin/worker-policy.cjs'),
  );
  writeFileSync(
    handler,
    `const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const payload = fs.readFileSync(0, 'utf8');
const input = JSON.parse(payload);
const command = input.tool_input?.command ?? null;
const marker = __filename + '.crashed';
const crash = command?.endsWith(' add -- implementation.txt') && !fs.existsSync(marker);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({command,sessionId:input.session_id,crash:!!crash,
  implementationPresent:fs.existsSync(${JSON.stringify(target)}) && fs.readFileSync(${JSON.stringify(target)},'utf8') === ${JSON.stringify(content)},
  unpublishedWorkPresent:fs.readFileSync(${JSON.stringify(preserved)},'utf8') === 'retain unrelated unpublished work\\n'
}) + '\\n');
if (crash) { fs.writeFileSync(marker, 'crashed'); throw new Error('LCARS_WORKFLOW_CONTROL_CRASH'); }
const result = spawnSync(process.execPath, [${JSON.stringify(policy)}], {input:payload,encoding:'utf8',timeout:3000});
process.stdout.write(result.stdout || '');
process.exit(result.status ?? 1);
`,
  );
  return {
    install(provider, configPath) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      let replaced = 0;
      if (provider === 'opencode') {
        const nativePlugin = pathToFileURL(
          realpathSync(
            resolve('packages/fleet-tools/bin/worker-opencode-plugin.mjs'),
          ),
        ).href;
        const bridge = pathToFileURL(
          realpathSync(
            resolve('packages/fleet-tools/bin/worker-hook-bridge.cjs'),
          ),
        ).href;
        const wrapper = join(directory, 'workflow-fault-plugin.mjs');
        writeFileSync(
          wrapper,
          `import nativePlugin from ${JSON.stringify(nativePlugin)};
import bridge from ${JSON.stringify(bridge)};
export default async (context) => {
  const hooks = await nativePlugin(context);
  return {...hooks, 'tool.execute.before': async (input, output) => {
    const original = bridge.invoke;
    bridge.invoke = (_handler, payload, options) => original(${JSON.stringify(handler)}, payload, options);
    try { await hooks['tool.execute.before'](input, output); }
    finally { bridge.invoke = original; }
  }};
};
`,
        );
        config.plugin = config.plugin.map((entry) => {
          if (entry !== nativePlugin) return entry;
          replaced++;
          return pathToFileURL(wrapper).href;
        });
      } else {
        for (const group of config.hooks.PreToolUse)
          for (const hook of group.hooks)
            if (hook.command?.includes(quote(policy))) {
              hook.command = hook.command.replace(
                quote(policy),
                quote(handler),
              );
              replaced++;
            }
      }
      if (replaced !== 1) throw new Error('Expected one installed evaluator');
      writeFileSync(configPath, JSON.stringify(config));
    },
    verify(contextPath, attemptId, sessionId, deadline) {
      try {
        const events = readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        const crashIndex = events.findIndex((event) => event.crash);
        const recovery = events.slice(crashIndex, crashIndex + 4);
        const receipt = (suffix) =>
          readFileSync(`${contextPath}.${suffix}`, 'utf8') === attemptId;
        return {
          oneCrash: events.filter((event) => event.crash).length === 1,
          usefulWorkRetained:
            recovery.length === 4 &&
            recovery.every(
              (event) =>
                event.implementationPresent && event.unpublishedWorkPresent,
            ),
          sameNativeSession:
            !!sessionId &&
            events.every((event) => event.sessionId === sessionId),
          allowDenyThenRetry:
            recovery.length === 4 &&
            recovery[1].command === 'echo LCARS_RECOVERY_READ_PROBE' &&
            recovery[2].command === 'git commit --no-verify' &&
            recovery[3].command === recovery[0].command &&
            !recovery[3].crash,
          recoverySucceeded:
            receipt('recovery-used') && receipt('recovery-succeeded'),
          noTerminalFailure: !existsSync(`${contextPath}.control-failed`),
          originalDeadlineRetained:
            Number.isFinite(deadline) && Date.now() < deadline,
        };
      } catch (error) {
        return { error: error.message };
      }
    },
  };
}
