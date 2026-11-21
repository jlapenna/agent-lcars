import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @nx/enforce-module-boundaries -- OpenCode 2 requires a folder package inside packages/fleet-tools/bin; sibling runtime files ship in the same @agent-lcars/agent-tools package.
import bridge from '../worker-hook-bridge.cjs';
// eslint-disable-next-line @nx/enforce-module-boundaries -- OpenCode 2 requires a folder package inside packages/fleet-tools/bin; sibling runtime files ship in the same @agent-lcars/agent-tools package.
import { sessionResolver } from '../worker-opencode-session.mjs';

const POLICY_PATH = fileURLToPath(
  new URL('../worker-policy.cjs', import.meta.url),
);
const RECURSIVE_DELEGATION_DENIAL =
  'Child reviewers and subagents must return evidence directly and may not recursively delegate.';

export function createBeforeToolEvaluator({ directory, clientOrSession }) {
  if (!bridge.isDispatch(process.env)) return undefined;
  const context = JSON.parse(
    readFileSync(process.env.LCARS_WORKER_CONTEXT, 'utf8'),
  );
  const resolveSession = sessionResolver(context, clientOrSession);
  return async ({ sessionID, tool, args }) => {
    const event = await resolveSession({
      session_id: sessionID,
      tool_name: tool === 'bash' || tool === 'shell' ? 'Bash' : tool,
      tool_input: args,
      cwd: directory,
    });
    // Child reviewers and validators return evidence only and never
    // recursively delegate (`anthropic-code-review/README.md`).
    if (event.native_session_id && (tool === 'subagent' || tool === 'task')) {
      throw new Error(RECURSIVE_DELEGATION_DENIAL);
    }
    // A synchronous evaluator running inside the CLI cannot time itself out.
    // Use the same bounded child and one-recovery allowance as command hooks.
    // This executes policy only, never the proposed tool or an external write.
    const result = bridge.invoke(
      POLICY_PATH,
      JSON.stringify(event),
    ).hookSpecificOutput;
    if (result.permissionDecision === 'deny') {
      throw new Error(result.permissionDecisionReason);
    }
    if (result.updatedInput && args && typeof args === 'object') {
      Object.assign(args, result.updatedInput);
    }
  };
}

// Registration and context creation belong to setup. This adapter translates
// the native interception event, not policy or installation discovery.
export default async function workerPolicy({ directory, client }) {
  const evaluate = createBeforeToolEvaluator({
    directory,
    clientOrSession: client,
  });
  if (!evaluate) return {};
  return {
    'tool.execute.before': async (input, output) => {
      await evaluate({
        sessionID: input.sessionID,
        tool: input.tool,
        args: output.args,
      });
    },
  };
}
