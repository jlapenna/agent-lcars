import { _resetForTesting } from '@repo/agent-telemetry/server';
import { logger } from '@repo/logging';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  Firestore,
  getFirestore as getAdminFirestore,
} from 'firebase-admin/firestore';
import { FakeFirestore } from 'firestore-jest-mock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArgumentsCamelCase } from 'yargs';

import { upsertCommand } from './upsert';

jest.mock('firebase-admin/app', () => ({
  getApps: jest.fn().mockReturnValue([]),
  initializeApp: jest.fn().mockReturnValue({}),
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  Timestamp: jest.requireActual('@google-cloud/firestore').Timestamp,
}));

jest.mock('@repo/util-server', () => ({
  ...jest.requireActual('@repo/util-server'),
  isEmulator: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('test-project'),
  getFirestoreEmulatorHost: jest.fn().mockReturnValue(undefined),
}));

function transcriptLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    sessionId: 'session-cli-upsert',
    timestamp: '2026-07-10T10:00:00.000Z',
    ...overrides,
  });
}

function writeTranscript(dir: string, lines: string[]): string {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

describe('upsertCommand', () => {
  let fakeFirestore: Firestore;
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetForTesting();
    jest.spyOn(logger, 'info').mockImplementation();
    jest.spyOn(logger, 'error').mockImplementation();

    fakeFirestore = new FakeFirestore(
      {},
      { mutable: true },
    ) as unknown as Firestore;
    (getApps as jest.Mock).mockReturnValue([]);
    (initializeApp as jest.Mock).mockReturnValue({});
    (getAdminFirestore as jest.Mock).mockReturnValue(fakeFirestore);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-telemetry-'));
  });

  it('reduces a transcript and upserts a cli session doc into the emulator', async () => {
    const transcriptFile = writeTranscript(tmpDir, [
      transcriptLine({
        uuid: 'uuid-1',
        cwd: '/home/dev/project',
        gitBranch: 'main',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Fix the flaky test' }],
        },
      }),
      transcriptLine({
        uuid: 'uuid-2',
        timestamp: '2026-07-10T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'Sure, looking now.' }],
        },
      }),
    ]);

    const argv = {
      'transcript-file': transcriptFile,
      _: [],
      $0: 'test',
    } as unknown as ArgumentsCamelCase<{
      'transcript-file': string;
      'run-id'?: string;
      'issue-number'?: number;
    }>;

    await upsertCommand.handler(argv);

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-cli-upsert')
      .get();
    expect(snap.exists).toBe(true);

    const data = snap.data();
    expect(data?.['source']).toBe('cli');
    expect(data?.['liveness']).toBe('ended');
    expect(data?.['cwd']).toBe('/home/dev/project');
    expect(data?.['branch']).toBe('main');
    expect(data?.['runId']).toBeUndefined();
    expect(data?.['issueNumber']).toBeUndefined();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Upserted session session-cli-upsert (cli, ended)',
      ),
    );
  });

  it('carries --run-id/--issue-number into an issue-agent session doc', async () => {
    const transcriptFile = writeTranscript(tmpDir, [
      transcriptLine({
        uuid: 'uuid-1',
        entrypoint: 'claude-code-github-action',
        cwd: '/home/runner/work/members/members',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Implement the store' }],
        },
      }),
    ]);

    const argv = {
      'transcript-file': transcriptFile,
      'run-id': 'run-123',
      'issue-number': 2539,
      _: [],
      $0: 'test',
    } as unknown as ArgumentsCamelCase<{
      'transcript-file': string;
      'run-id'?: string;
      'issue-number'?: number;
    }>;

    await upsertCommand.handler(argv);

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-cli-upsert')
      .get();
    const data = snap.data();
    expect(data?.['source']).toBe('issue-agent');
    expect(data?.['runId']).toBe('run-123');
    expect(data?.['issueNumber']).toBe(2539);
    expect(data?.['host']).toBeUndefined();
    expect(data?.['cwd']).toBeUndefined();
  });

  it('errors out without upserting when the transcript file is missing', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Exit called');
    });

    const argv = {
      'transcript-file': path.join(tmpDir, 'does-not-exist.jsonl'),
      _: [],
      $0: 'test',
    } as unknown as ArgumentsCamelCase<{
      'transcript-file': string;
      'run-id'?: string;
      'issue-number'?: number;
    }>;

    await expect(upsertCommand.handler(argv)).rejects.toThrow('Exit called');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Transcript file not found'),
    );
    exitSpy.mockRestore();
  });
});
