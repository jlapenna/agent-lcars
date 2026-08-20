export * from './context';
export * from './instance';
export * from './log-level';
export * from './utils';
export {
  forceStructuredLogging,
  getLogLevel,
  isOnGoogleCloud,
} from '@agent-lcars/env';
export type {
  LogEnricher,
  LogEnrichment,
  LogFormatter,
} from '@jlapenna/fleet-runtime/logging';
export {
  Logger,
  setLogDefaults,
  setLogEnricher,
  setLogFormatter,
} from '@jlapenna/fleet-runtime/logging';
