#!/usr/bin/env node
'use strict';

// PreToolUse transport for providers whose native hook errors fail open.
// Registration/setup supplies the trusted handler path; workers do not select it.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function isDispatch(env) {
  return Boolean(
    env.LCARS_RUN_ID?.trim() || env.AGENT_DISPATCH_CONTEXT?.trim(),
  );
}

function deny() {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'LCARS control execution failed. The action was not run; preserve work and recover the control before retrying.',
    },
  };
}

function invoke(handler, input, options = {}) {
  const result = spawnSync(process.execPath, [handler], {
    input,
    encoding: 'utf8',
    timeout: options.timeout ?? 5000,
    maxBuffer: 1024 * 1024,
    env: options.env ?? process.env,
  });
  // Never expose handler stderr: an exception may include task content/secrets.
  if (result.error || result.status !== 0) return deny();
  try {
    const output = JSON.parse(result.stdout);
    const decision = output?.hookSpecificOutput;
    // Reject unsupported keys rather than emitting a shape the provider may
    // treat as an error and ignore. This bridge only implements PreToolUse.
    if (
      Object.keys(output).some((key) => key !== 'hookSpecificOutput') ||
      !decision ||
      decision.hookEventName !== 'PreToolUse' ||
      !['allow', 'deny'].includes(decision.permissionDecision) ||
      Object.keys(decision).some(
        (key) =>
          ![
            'hookEventName',
            'permissionDecision',
            'permissionDecisionReason',
            'updatedInput',
          ].includes(key),
      ) ||
      (decision.permissionDecisionReason !== undefined &&
        typeof decision.permissionDecisionReason !== 'string')
    ) {
      return deny();
    }
    if (decision.updatedInput !== undefined) {
      const original = JSON.parse(input);
      const updated = decision.updatedInput;
      // Only the native Bash command rewrite is qualified by our CLI probes.
      // Never forward a malformed rewrite: provider errors may fail open.
      if (
        decision.permissionDecision !== 'allow' ||
        original.tool_name !== 'Bash' ||
        !updated ||
        typeof updated !== 'object' ||
        Array.isArray(updated) ||
        typeof updated.command !== 'string' ||
        Object.keys(updated).some((key) => key !== 'command')
      )
        return deny();
    }
    return output;
  } catch {
    return deny();
  }
}

if (require.main === module && isDispatch(process.env)) {
  let output;
  try {
    const [handler, ...extra] = process.argv.slice(2);
    if (!handler || extra.length) throw new Error('invalid handler');
    output = invoke(handler, fs.readFileSync(0, 'utf8'));
  } catch {
    output = deny();
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = { invoke, isDispatch };
