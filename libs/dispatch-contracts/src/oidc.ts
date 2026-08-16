/** Audience requested by worker workflows when they call hosted completion. */
export const COMPLETION_OIDC_AUDIENCE = 'agent-lcars-dispatch-completion';

/** Reusable workflow whose isolated job is allowed to report completion. */
export const COMPLETION_FINALIZER_WORKFLOW_PATH =
  '.github/workflows/agent-fallback-finalize.yml';

/** Public App Hosting route that accepts an authenticated worker completion. */
export const HOSTED_COMPLETION_PATH = '/api/control-plane/completion';

/** Canonical production endpoint used by the trusted worker callback. */
export const HOSTED_COMPLETION_URL = `https://lcars.jlapenna.net${HOSTED_COMPLETION_PATH}`;

/** Public, read-only lifecycle aggregate backed by authoritative storage. */
export const HOSTED_TASK_STATE_PATH = '/api/control-plane/task-state';
export const HOSTED_TASK_STATE_URL = `https://lcars.jlapenna.net${HOSTED_TASK_STATE_PATH}`;
