import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultClaudeProjectsDir,
  defaultCodexSessionsDir,
  defaultSessionStateDir,
  loadSharedConfig,
} from './config';

const ENV_KEYS = [
  'AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR',
  'AGENT_TELEMETRY_CODEX_SESSIONS_DIR',
  'AGENT_TELEMETRY_PROJECT_ID',
  'AGENT_TELEMETRY_TRANSCRIPTS_BUCKET',
  'AGENT_TELEMETRY_WRITER_KEY_JSON',
  'FIRESTORE_EMULATOR_HOST',
] as const;

describe('config', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe('default directories', () => {
    it('defaults under the home directory', () => {
      expect(defaultClaudeProjectsDir()).toBe(
        path.join(os.homedir(), '.claude', 'projects'),
      );
      expect(defaultCodexSessionsDir()).toBe(
        path.join(os.homedir(), '.codex', 'sessions'),
      );
      expect(defaultSessionStateDir()).toBe(
        path.join(os.homedir(), '.local', 'state', 'agent-lcars'),
      );
    });

    it('respects the projects and sessions dir overrides', () => {
      process.env['AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR'] = '/tmp/projects';
      process.env['AGENT_TELEMETRY_CODEX_SESSIONS_DIR'] = '/tmp/sessions';

      expect(defaultClaudeProjectsDir()).toBe('/tmp/projects');
      expect(defaultCodexSessionsDir()).toBe('/tmp/sessions');
    });
  });

  describe('loadSharedConfig', () => {
    it('leaves the Firestore target unset by default', () => {
      const config = loadSharedConfig();

      expect(config.firestoreProjectId).toBeUndefined();
      expect(config.firestoreWriterKeyJson).toBeUndefined();
      expect(config.firestoreEmulatorHost).toBeUndefined();
    });

    it('reads the Firestore target from the environment', () => {
      process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';
      process.env['FIRESTORE_EMULATOR_HOST'] = 'localhost:8080';

      const config = loadSharedConfig();

      expect(config.firestoreProjectId).toBe('agent-lcars');
      expect(config.firestoreEmulatorHost).toBe('localhost:8080');
    });

    describe('transcriptsBucket (issue #24)', () => {
      it('is undefined when no project id is configured', () => {
        expect(loadSharedConfig().transcriptsBucket).toBeUndefined();
      });

      it('derives the bucket name from the configured project id', () => {
        process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';

        expect(loadSharedConfig().transcriptsBucket).toBe(
          'agent-lcars-session-transcripts',
        );
      });

      it('respects an explicit bucket override', () => {
        process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';
        process.env['AGENT_TELEMETRY_TRANSCRIPTS_BUCKET'] = 'custom-bucket';

        expect(loadSharedConfig().transcriptsBucket).toBe('custom-bucket');
      });
    });
  });
});
