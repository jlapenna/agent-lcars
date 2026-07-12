import { WatcherConfig } from './config';
import { createStoreFromConfig } from './create-store';
import * as store from './store';

describe('createStoreFromConfig', () => {
  const baseConfig: WatcherConfig = {
    claudeProjectsDir: '/root/.claude/projects',
    allowlist: ['*'],
    host: 'test-host',
    heartbeatIntervalMs: 10_000,
    stalenessWindowMs: 50_000,
  };

  it('falls back to a log-only store when no credentials or emulator are configured', () => {
    const fakeStore = { upsertSession: jest.fn() };
    const logOnlySpy = jest
      .spyOn(store, 'createLogOnlyStore')
      .mockReturnValue(fakeStore);

    createStoreFromConfig(baseConfig);

    expect(logOnlySpy).toHaveBeenCalledTimes(1);
  });

  it('uses the Firestore emulator when configured', () => {
    const fakeStore = { upsertSession: jest.fn() };
    const firestoreSpy = jest
      .spyOn(store, 'createFirestoreStore')
      .mockReturnValue(fakeStore);

    createStoreFromConfig({
      ...baseConfig,
      firestoreEmulatorHost: 'localhost:8080',
    });

    expect(firestoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({ emulatorHost: 'localhost:8080' }),
    );
  });

  it('uses real Firestore credentials when a project id and writer key are configured', () => {
    const fakeStore = { upsertSession: jest.fn() };
    const firestoreSpy = jest
      .spyOn(store, 'createFirestoreStore')
      .mockReturnValue(fakeStore);
    const key = JSON.stringify({
      client_email: 'writer@example.iam.gserviceaccount.com',
      private_key: 'fake-key',
    });

    createStoreFromConfig({
      ...baseConfig,
      firestoreProjectId: 'supersprinklesracing',
      firestoreWriterKeyJson: key,
    });

    expect(firestoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'supersprinklesracing',
        credentials: {
          client_email: 'writer@example.iam.gserviceaccount.com',
          private_key: 'fake-key',
        },
      }),
    );
  });
});
