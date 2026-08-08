import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QUICK_TASK_PREFERENCES_STORAGE_KEY,
  readQuickTaskPreferences,
  writeQuickTaskPreferences,
} from './quick-task-preferences';

describe('Quick Task preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips only the stable repository identity and pipeline', () => {
    writeQuickTaskPreferences({
      repoKey: 'jlapenna/agent-lcars',
      pipeline: 'codex',
    });

    expect(readQuickTaskPreferences()).toEqual({
      repoKey: 'jlapenna/agent-lcars',
      pipeline: 'codex',
    });
  });

  it('degrades corrupt storage to no remembered selection', () => {
    window.localStorage.setItem(
      QUICK_TASK_PREFERENCES_STORAGE_KEY,
      '{not json',
    );

    expect(readQuickTaskPreferences()).toEqual({});
  });

  it('drops invalid fields instead of trusting hand-edited storage', () => {
    window.localStorage.setItem(
      QUICK_TASK_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ repoKey: 42, pipeline: 'unknown', token: 'ignored' }),
    );

    expect(readQuickTaskPreferences()).toEqual({
      repoKey: undefined,
      pipeline: undefined,
    });
  });

  it('does not let an unavailable storage backend block the dialog', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(readQuickTaskPreferences()).toEqual({});

    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() =>
      writeQuickTaskPreferences({ repoKey: 'org/repo', pipeline: 'claude' }),
    ).not.toThrow();
  });
});
