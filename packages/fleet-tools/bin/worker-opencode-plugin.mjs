import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import bridge from './worker-hook-bridge.cjs';
import policy from './worker-policy.cjs';
import session from './worker-session.cjs';

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
      const event = {
        session_id: input.sessionID,
        tool_name: input.tool === 'bash' ? 'Bash' : input.tool,
        tool_input: output.args,
        cwd: directory,
      };
      const rejected = session.rejection(event, context);
      if (rejected) throw new Error(rejected);
      try {
        result = policy.evaluate(event, context).hookSpecificOutput;
      } catch {
        // Restart only the failed evaluator in a fresh process. Shared recovery
        // consumes one attempt-bound allowance and proves allow/deny before
        // evaluating this still-unexecuted tool again.
        result = bridge.recover(
          fileURLToPath(new URL('./worker-policy.cjs', import.meta.url)),
          JSON.stringify(event),
        ).hookSpecificOutput;
      }
      if (result.permissionDecision === 'deny')
        throw new Error(result.permissionDecisionReason);
      if (result.updatedInput) Object.assign(output.args, result.updatedInput);
    },
  };
}
