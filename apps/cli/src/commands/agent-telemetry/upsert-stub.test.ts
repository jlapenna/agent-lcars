import { _resetForTesting } from '@agent-lcars/telemetry/server';
import { logger } from '@repo/logging';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  Firestore,
  getFirestore as getAdminFirestore,
} from 'firebase-admin/firestore';
import { FakeFirestore } from 'firestore-jest-mock';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ArgumentsCamelCase } from 'yargs';

import { upsertStubCommand } from './upsert-stub';

vi.mock('firebase-admin/app', async () => ({
  getApps: vi.fn().mockReturnValue([]),
  initializeApp: vi.fn().mockReturnValue({}),
}));

vi.mock('firebase-admin/firestore', async () => ({
  getFirestore: vi.fn(),
  Timestamp: (await vi.importActual('@google-cloud/firestore')).Timestamp,
}));

vi.mock('@repo/util-server', async () => ({
  ...(await vi.importActual('@repo/util-server')),
  isEmulator: vi.fn().mockReturnValue(false),
  getProjectId: vi.fn().mockReturnValue('test-project'),
  getFirestoreEmulatorHost: vi.fn().mockReturnValue(undefined),
}));

interface UpsertStubArgs {
  'session-id': string;
  agent: string;
  'run-id'?: string;
  'issue-number'?: number;
  title?: string;
  'started-at': string;
  'last-activity-at'?: string;
  'transcript-gcs-uri'?: string;
}

function argv(
  overrides: Partial<UpsertStubArgs>,
): ArgumentsCamelCase<UpsertStubArgs> {
  return {
    'session-id': 'opencode-run-123',
    agent: 'opencode',
    'started-at': '2026-07-19T10:00:00.000Z',
    ...overrides,
    _: [],
    $0: 'test',
  } as unknown as ArgumentsCamelCase<UpsertStubArgs>;
}

describe('upsertStubCommand', () => {
  let fakeFirestore: Firestore;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    fakeFirestore = new FakeFirestore(
      {},
      { mutable: true },
    ) as unknown as Firestore;
    (getApps as Mock).mockReturnValue([]);
    (initializeApp as Mock).mockReturnValue({});
    (getAdminFirestore as Mock).mockReturnValue(fakeFirestore);
  });

  it('upserts a stub session doc with the given agent/source/runId/issueNumber/URIs', async () => {
    await upsertStubCommand.handler(
      argv({
        'run-id': 'run-456',
        'issue-number': 3123,
        title: 'Archive-first session shipping',
        'transcript-gcs-uri':
          'gs://supersprinklesracing-agent-session-transcripts/runs/run-456/opencode/',
      }),
    );

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('opencode-run-123')
      .get();
    expect(snap.exists).toBe(true);

    const data = snap.data();
    expect(data?.['source']).toBe('issue-agent');
    expect(data?.['agent']).toBe('opencode');
    expect(data?.['liveness']).toBe('ended');
    expect(data?.['runId']).toBe('run-456');
    expect(data?.['issueNumber']).toBe(3123);
    expect(data?.['title']).toBe('Archive-first session shipping');
    expect(data?.['transcriptGcsUri']).toBe(
      'gs://supersprinklesracing-agent-session-transcripts/runs/run-456/opencode/',
    );
    expect(data?.['turns']).toBe(0);
    expect(data?.['toolCallCounts']).toEqual({});
    expect(data?.['deliverables']).toEqual({ prNumbers: [], commitShas: [] });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Upserted stub session opencode-run-123 (issue-agent, agent=opencode)',
      ),
    );
  });

  it('defaults --last-activity-at to --started-at when omitted', async () => {
    await upsertStubCommand.handler(argv({}));

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('opencode-run-123')
      .get();
    const data = snap.data();
    expect(data?.['startedAt']).toBe('2026-07-19T10:00:00.000Z');
    expect(data?.['lastActivityAt']).toBe('2026-07-19T10:00:00.000Z');
  });

  it('omits runId/issueNumber/transcriptGcsUri/title when not passed', async () => {
    await upsertStubCommand.handler(argv({}));

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('opencode-run-123')
      .get();
    const data = snap.data();
    expect(data?.['runId']).toBeUndefined();
    expect(data?.['issueNumber']).toBeUndefined();
    expect(data?.['transcriptGcsUri']).toBeUndefined();
    expect(data?.['title']).toBeUndefined();
  });

  it('exits non-zero without upserting when --agent is not a valid SessionAgent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Exit called');
    });

    await expect(
      upsertStubCommand.handler(argv({ agent: 'not-a-real-agent' })),
    ).rejects.toThrow('Exit called');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --agent "not-a-real-agent"'),
    );

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('opencode-run-123')
      .get();
    expect(snap.exists).toBe(false);

    exitSpy.mockRestore();
  });
});
