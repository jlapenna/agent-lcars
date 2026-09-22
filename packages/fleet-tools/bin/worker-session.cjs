'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The provider allocates a native session before its first tool. Bind that
// trusted event to the setup-owned attempt before permitting task actions.
// Publish a complete immutable record atomically so parallel hooks cannot
// replace the winner or observe a partially written identity.
function rejection(input, context, env = process.env, allowBinding = true) {
  let temporary;
  try {
    const sessionId = input.session_id;
    const contextPath = env.LCARS_WORKER_CONTEXT;
    if (
      typeof sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !contextPath ||
      !path.isAbsolute(contextPath) ||
      context.runId !== env.LCARS_RUN_ID ||
      (env.ATTEMPT_ID && env.ATTEMPT_ID !== context.attemptId) ||
      (context.nativeSessionId && context.nativeSessionId !== sessionId)
    )
      throw new Error('Invalid native binding');
    const record = JSON.stringify({
      provider: context.provider,
      runId: context.runId,
      attemptId: context.attemptId,
      sessionId,
    });
    const destination = `${contextPath}.session.json`;
    if (!fs.existsSync(destination)) {
      if (!allowBinding) throw new Error('Native binding is missing');
      temporary = fs.mkdtempSync(
        path.join(path.dirname(contextPath), '.worker-session-'),
      );
      const staged = path.join(temporary, 'binding.json');
      fs.writeFileSync(staged, record, { mode: 0o600 });
      try {
        fs.linkSync(staged, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stat = fs.lstatSync(destination);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.readFileSync(destination, 'utf8') !== record
    )
      throw new Error('Native binding changed');
    return null;
  } catch {
    return 'Native session identity does not match the setup-owned attempt, or its binding cannot be verified. Do not run this action or replace the binding; preserve work and reconcile the runner session.';
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Read only an already-established, still-valid root. A failed lineage lookup
// must never create or replace the attempt's binding.
function boundSession(context, env = process.env) {
  try {
    const record = JSON.parse(
      fs.readFileSync(`${env.LCARS_WORKER_CONTEXT}.session.json`, 'utf8'),
    );
    return rejection({ session_id: record.sessionId }, context, env, false) ===
      null
      ? record.sessionId
      : null;
  } catch {
    return null;
  }
}

module.exports = { rejection, boundSession };
