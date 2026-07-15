import fetchMock from 'jest-fetch-mock';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.enableMocks();
  fetchMock.doMock((_res) =>
    Promise.resolve({
      body: 'Fetch is mocked out',
      status: 595,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});
