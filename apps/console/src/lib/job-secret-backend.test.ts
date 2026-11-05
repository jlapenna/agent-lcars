import { beforeEach, expect, it, vi } from 'vitest';

import { GoogleJobSecretBackend } from './job-secret-backend';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return { request: mocks.read };
    }
  },
  Impersonated: class {
    request = mocks.write;
  },
}));
let backend: GoogleJobSecretBackend;
beforeEach(() => {
  vi.resetAllMocks();
  backend = new GoogleJobSecretBackend(
    'lcars-job-secrets',
    'job-secret-writer@lcars-job-secrets.iam.gserviceaccount.com',
  );
});
it('uses one project, concrete versions, and a separate upload identity', async () => {
  mocks.read
    .mockResolvedValueOnce({
      data: { labels: { application: 'lcars-job-secrets' } },
    })
    .mockResolvedValueOnce({
      data: {
        payload: { data: Buffer.from('fixture-secret').toString('base64') },
      },
    });
  mocks.write.mockResolvedValue({
    data: { name: 'projects/lcars-job-secrets/secrets/example/versions/2' },
  });
  await backend.checkContainer('example');
  expect(await backend.readVersion('example', '1')).toBe('fixture-secret');
  expect(await backend.addVersion('example', 'fixture-next')).toBe('2');
  expect(mocks.read.mock.calls.map(([input]) => input.url)).toEqual([
    'https://secretmanager.googleapis.com/v1/projects/lcars-job-secrets/secrets/example',
    'https://secretmanager.googleapis.com/v1/projects/lcars-job-secrets/secrets/example/versions/1:access',
  ]);
  expect(mocks.write).toHaveBeenCalledOnce();
});
it.each([
  ['other/project', '1'],
  ['example', 'latest'],
  ['example', '../1'],
  ['https://foreign.example', '1'],
])('rejects caller-controlled resource %s %s', async (name, version) => {
  await expect(backend.readVersion(name!, version!)).rejects.toThrow();
  expect(mocks.read).not.toHaveBeenCalled();
});
it('rejects unowned containers and sanitizes credential-bearing SDK failures', async () => {
  mocks.read.mockResolvedValueOnce({
    data: { labels: { application: 'homelab' } },
  });
  await expect(backend.checkContainer('example')).rejects.toThrow(
    'not provisioned',
  );
  mocks.read.mockRejectedValue(
    new Error('Authorization: Bearer fixture-private-token'),
  );
  await expect(backend.readVersion('example', '1')).rejects.toThrow(
    /^LCARS secret backend operation failed$/u,
  );
  mocks.write.mockRejectedValue(new Error('payload fixture-private-token'));
  await expect(
    backend.addVersion('example', 'fixture-private-token'),
  ).rejects.toThrow(/^LCARS secret backend operation failed$/u);
});
