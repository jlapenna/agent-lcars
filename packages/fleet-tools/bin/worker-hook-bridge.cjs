#!/usr/bin/env node
'use strict';

// PreToolUse transport for providers whose native hook errors fail open.
// Registration/setup supplies the trusted handler path; workers do not select it.
const fs = require('node:fs');
const path = require('node:path');
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
        'LCARS control execution failed and automatic recovery is unavailable or exhausted. The action was not run. Preserve work and report an infrastructure failure; do not fabricate a human blocker or PARK.',
    },
  };
}

function invokeOnce(handler, input, options = {}) {
  // OpenCode embeds Bun: process.execPath there is the OpenCode CLI, not a
  // JavaScript interpreter. The runner image provisions Node on its PATH.
  const executable = process.versions.bun ? 'node' : process.execPath;
  const result = spawnSync(executable, [handler], {
    input,
    encoding: 'utf8',
    timeout: options.timeout ?? 5000,
    maxBuffer: 1024 * 1024,
    env: options.env ?? process.env,
  });
  // Never expose handler stderr: an exception may include task content/secrets.
  if (result.error || result.status !== 0) return null;
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
      return null;
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
        return null;
    }
    return output;
  } catch {
    return null;
  }
}

// Share one attempt-bound allowance between evaluator and native API recovery.
// These are execution receipts, not installation-presence checks.
function recoveryState(env = process.env) {
  try {
    const contextPath = env.LCARS_WORKER_CONTEXT;
    if (!isDispatch(env) || !contextPath || !path.isAbsolute(contextPath))
      return null;
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    if (
      context.policyVersion !== 1 ||
      !['claude', 'codex', 'opencode'].includes(context.provider) ||
      context.runId !== env.LCARS_RUN_ID ||
      (env.ATTEMPT_ID && env.ATTEMPT_ID !== context.attemptId) ||
      typeof context.attemptId !== 'string' ||
      context.attemptId !==
        `g${context.runId?.match(/\/r([1-9][0-9]*)$/)?.[1]}:${context.runId}`
    )
      return null;
    const failed = () => {
      try {
        fs.writeFileSync(`${contextPath}.control-failed`, context.attemptId, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {
        // Existing evidence is retained; diagnostics must not expose task data.
      }
      return deny();
    };
    const write = (suffix) =>
      fs.writeFileSync(`${contextPath}.${suffix}`, context.attemptId, {
        flag: 'wx',
        mode: 0o600,
      });
    return {
      failed,
      claim: () => write('recovery-used'),
      succeeded: () => write('recovery-succeeded'),
    };
  } catch {
    return null;
  }
}

// Only entered after a control execution failure. Never executes the proposed
// tool: restarting the evaluator cannot replay a publication or code mutation.
// Atomic creation shares one recovery allowance across hooks and resumed rounds.
function recover(handler, input, options = {}) {
  let failed = deny;
  try {
    const state = recoveryState(options.env ?? process.env);
    if (!state) return deny();
    failed = state.failed;
    state.claim();
    // The outer provider process remains under its existing runner deadline.
    // This additional bound fits inside the native hook timeout, without a new
    // task budget. A crash consumes the allowance rather than resetting it.
    const deadline = Date.now() + 4000;
    const run = (payload) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      return invokeOnce(handler, payload, {
        ...options,
        timeout: Math.min(remaining, options.timeout ?? 2000),
      });
    };
    for (const [command, expected] of [
      ['echo LCARS_RECOVERY_READ_PROBE', 'allow'],
      ['git commit --no-verify', 'deny'],
    ]) {
      const result = run(
        JSON.stringify({
          tool_name: 'Bash',
          session_id: JSON.parse(input).session_id,
          tool_input: { command },
          cwd: process.cwd(),
        }),
      );
      if (result?.hookSpecificOutput.permissionDecision !== expected)
        return failed();
    }
    const result = run(input);
    if (!result) return failed();
    state.succeeded();
    return result;
  } catch {
    return failed();
  }
}

function invoke(handler, input, options = {}) {
  return (
    invokeOnce(handler, input, options) ?? recover(handler, input, options)
  );
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

module.exports = { invoke, recover, isDispatch, recoveryState, failure: deny };
