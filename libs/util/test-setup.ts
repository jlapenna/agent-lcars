import { afterEach, beforeEach, jest } from '@jest/globals';
import fetchMock from 'jest-fetch-mock';

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.enableMocks();
  fetchMock.doMock((_res) =>
    Promise.resolve({
      body: 'Fetch is mocked out',
      status: 595,
    }),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});
