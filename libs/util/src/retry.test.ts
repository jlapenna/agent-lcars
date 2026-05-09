import { retry } from './retry';

describe('retry', () => {
  it('should return the result if the operation succeeds immediately', async () => {
    const operation = jest.fn().mockResolvedValue('success');
    const result = await retry(operation);

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry if the operation fails and eventually succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const result = await retry(operation, { minTimeout: 1, retries: 3 });

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should fail if the operation fails more than the maximum retries', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('fail forever'));

    await expect(
      retry(operation, { minTimeout: 1, retries: 2 }),
    ).rejects.toThrow('fail forever');
    expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should respect the shouldRetry predicate', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('fatal error'));

    await expect(
      retry(operation, {
        minTimeout: 1,
        retries: 3,
        shouldRetry: (err) => (err as Error).message !== 'fatal error',
      }),
    ).rejects.toThrow('fatal error');

    expect(operation).toHaveBeenCalledTimes(1); // No retries because shouldRetry returned false
  });
});
