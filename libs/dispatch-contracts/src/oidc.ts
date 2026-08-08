/** Audience requested by worker workflows when they call hosted completion. */
export const COMPLETION_OIDC_AUDIENCE = 'agent-lcars-dispatch-completion';

/** Public App Hosting route that accepts an authenticated worker completion. */
export const HOSTED_COMPLETION_PATH = '/api/control-plane/completion';
