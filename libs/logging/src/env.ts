export function isOnGoogleCloud(): boolean {
  return (
    !!(
      process.env['K_SERVICE'] ||
      process.env['K_REVISION'] ||
      process.env['CLOUD_RUN_JOB']
    ) && process.env['FUNCTIONS_EMULATOR'] !== 'true'
  );
}

export function forceStructuredLogging(): boolean {
  return process.env['FORCE_STRUCTURED_LOGGING'] === 'true';
}

export function getLogLevel(): string | undefined {
  return process.env['LOG_LEVEL'];
}

export function getSlackLogLevel(): string | undefined {
  return process.env['SLACK_LOG_LEVEL'];
}
