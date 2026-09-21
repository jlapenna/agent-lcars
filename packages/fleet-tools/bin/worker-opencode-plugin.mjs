import { readFileSync } from 'node:fs';

import bridge from './worker-hook-bridge.cjs';
import policy from './worker-policy.cjs';

// Registration and context creation belong to setup. This adapter translates
// the native interception event, not policy or installation discovery.
export default async function workerPolicy({ directory }) {
  if (!bridge.isDispatch(process.env)) return {};
  const context = JSON.parse(
    readFileSync(process.env.LCARS_WORKER_CONTEXT, 'utf8'),
  );
  return {
    'tool.execute.before': async (input, output) => {
      let result;
      try {
        result = policy.evaluate(
          {
            tool_name: input.tool === 'bash' ? 'Bash' : input.tool,
            tool_input: output.args,
            cwd: directory,
          },
          context,
        ).hookSpecificOutput;
      } catch {
        // Native OpenCode throws prevent execution (verified by CLI probes).
        // Do not expose exception contents, which can contain task data.
        throw new Error(
          'LCARS control execution failed; preserve work and recover before retrying.',
        );
      }
      if (result.permissionDecision === 'deny')
        throw new Error(result.permissionDecisionReason);
      if (result.updatedInput) Object.assign(output.args, result.updatedInput);
    },
  };
}
