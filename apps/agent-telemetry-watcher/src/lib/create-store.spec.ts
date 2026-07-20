import { describe, expect, it, vi } from 'vitest';

import { createStoreFromConfig, StoreConfig } from './create-store';
import * as store from './store';

describe('createStoreFromConfig', () => {
  // StoreConfig (not the full WatcherConfig) is deliberately all this test
  // needs - createStoreFromConfig only ever reads the three firestore-*
  // fields, so an empty base object with no firestore config set is a
  // legitimate "falls back to log-only" starting point.
  const baseConfig: StoreConfig = {};

  it('falls back to a log-only store when no credentials or emulator are configured', () => {
    const fakeStore = { upsertSession: vi.fn() };
    const logOnlySpy = vi
      .spyOn(store, 'createLogOnlyStore')
      .mockReturnValue(fakeStore);

    createStoreFromConfig(baseConfig);

    expect(logOnlySpy).toHaveBeenCalledTimes(1);
  });

  it('uses the Firestore emulator when configured', () => {
    const fakeStore = { upsertSession: vi.fn() };
    const firestoreSpy = vi
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
    const fakeStore = { upsertSession: vi.fn() };
    const firestoreSpy = vi
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

  it('falls back to ambient Application Default Credentials when only a project id is configured (runner mode)', () => {
    const fakeStore = { upsertSession: vi.fn() };
    const firestoreSpy = vi
      .spyOn(store, 'createFirestoreStore')
      .mockReturnValue(fakeStore);

    createStoreFromConfig({
      firestoreProjectId: 'supersprinklesracing',
    });

    // Exact args (not objectContaining): no `credentials` key must be
    // present at all — that's what makes @google-cloud/firestore fall back
    // to ambient ADC instead of the writer-key-JSON path exercised above.
    expect(firestoreSpy).toHaveBeenCalledWith({
      projectId: 'supersprinklesracing',
    });
  });
});
