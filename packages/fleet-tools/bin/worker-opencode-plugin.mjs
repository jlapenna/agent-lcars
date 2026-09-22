import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import bridge from './worker-hook-bridge.cjs';
import { sessionResolver } from './worker-opencode-session.mjs';

// Registration and context creation belong to setup. This adapter translates
// the native interception event, not policy or installation discovery.
export default async function workerPolicy({ directory, client }) {
  if (!bridge.isDispatch(process.env)) return {};
  const context = JSON.parse(
    readFileSync(process.env.LCARS_WORKER_CONTEXT, 'utf8'),
  );
  const resolveSession = sessionResolver(context, client);
  return {
    'tool.execute.before': async (input, output) => {
      const event = await resolveSession({
        session_id: input.sessionID,
        tool_name: input.tool === 'bash' ? 'Bash' : input.tool,
        tool_input: output.args,
        cwd: directory,
      });
      // A synchronous evaluator running inside the CLI cannot time itself out.
      // Use the same bounded child and one-recovery allowance as command hooks.
      // This executes policy only, never the proposed tool or an external write.
      const result = bridge.invoke(
        fileURLToPath(new URL('./worker-policy.cjs', import.meta.url)),
        JSON.stringify(event),
      ).hookSpecificOutput;
      if (result.permissionDecision === 'deny')
        throw new Error(result.permissionDecisionReason);
      if (result.updatedInput) Object.assign(output.args, result.updatedInput);
    },
  };
}
