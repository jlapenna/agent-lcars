/**
 * Give commands launched by OpenCode's shell tool the native session id that
 * OpenCode already supplies to its supported `shell.env` plugin hook.
 *
 * `lcars session title` and `lcars session status` deliberately resolve the
 * current session from the caller's environment. OpenCode creates a fresh
 * session inside `opencode run`, after the parent direct runner has launched,
 * so the parent cannot export this value ahead of time. Injecting it here
 * keeps the annotation bound to the exact native session executing the tool.
 */
export default async function lcarsSessionEnvironment() {
  return {
    'shell.env': async ({ sessionID }, output) => {
      if (typeof sessionID === 'string' && sessionID.length > 0) {
        output.env.LCARS_SESSION_ID = sessionID;
      }
    },
  };
}
