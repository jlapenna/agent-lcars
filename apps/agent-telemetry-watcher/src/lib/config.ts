import { optional } from '@repo/env';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_PROJECT_DIR_ALLOWLIST } from './allowlist';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALENESS_MULTIPLIER = 5;

export interface WatcherConfig {
  claudeProjectsDir: string;
  allowlist: string[];
  host: string;
  heartbeatIntervalMs: number;
  stalenessWindowMs: number;
  firestoreProjectId?: string;
  firestoreWriterKeyJson?: string;
  firestoreEmulatorHost?: string;
}

/** Reads and validates the daemon's configuration from the environment. */
export function loadConfig(): WatcherConfig {
  const heartbeatIntervalMs = Number(
    optional('AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS') ??
      DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const stalenessWindowMs = Number(
    optional('AGENT_TELEMETRY_STALENESS_WINDOW_MS') ??
      heartbeatIntervalMs * DEFAULT_STALENESS_MULTIPLIER,
  );

  const allowlistRaw = optional('AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST');
  const allowlist = allowlistRaw
    ? allowlistRaw
        .split(',')
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
    : DEFAULT_PROJECT_DIR_ALLOWLIST;

  return {
    claudeProjectsDir:
      optional('AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR') ??
      path.join(os.homedir(), '.claude', 'projects'),
    allowlist,
    host: optional('AGENT_TELEMETRY_HOST') ?? os.hostname(),
    heartbeatIntervalMs,
    stalenessWindowMs,
    firestoreProjectId: optional('AGENT_TELEMETRY_PROJECT_ID'),
    firestoreWriterKeyJson: optional('AGENT_TELEMETRY_WRITER_KEY_JSON'),
    firestoreEmulatorHost: optional('FIRESTORE_EMULATOR_HOST'),
  };
}
