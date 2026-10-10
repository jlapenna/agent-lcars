import { describe, expect, it } from 'vitest';

import { labOptions } from '../e2e/measure-inbox-phone.mjs';

const environment = {
  E2E_HERMETIC: '1',
  PROJECT_ID: 'demo-no-project',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:4362',
};
const options = ['--origin', 'http://localhost:4204', '--out', '/tmp/lab.json'];

describe('phone performance lab safety boundary', () => {
  it.each([
    'https://lcars.jlapenna.net',
    'http://10.0.0.1:4204',
    'http://localhost:4204/inbox',
    'http://user:password@localhost:4204',
    'http://localhost:4204?redirect=example.com',
  ])('rejects unsafe origin %s before any fixture mutation', (origin) => {
    expect(() =>
      labOptions(['--origin', origin, '--out', '/tmp/lab.json'], environment),
    ).toThrow();
  });
  it.each([
    { ...environment, E2E_HERMETIC: '0' },
    { ...environment, PROJECT_ID: 'agent-lcars' },
    { ...environment, FIRESTORE_EMULATOR_HOST: '10.0.0.1:8080' },
  ])('rejects a non-hermetic environment', (env) => {
    expect(() => labOptions(options, env)).toThrow();
  });
  it.each(['0', '4', '61', '1.5', 'NaN'])(
    'rejects unbounded or undersampled count %s',
    (count) => {
      expect(() =>
        labOptions([...options, '--samples', count], environment),
      ).toThrow();
    },
  );
  it('accepts the bounded loopback profile and requires an artifact destination', () => {
    expect(labOptions(options, environment)).toMatchObject({
      origin: 'http://localhost:4204',
      samples: 30,
      out: '/tmp/lab.json',
    });
    expect(() =>
      labOptions(['--origin', 'http://localhost:4204'], environment),
    ).toThrow('Provide --out');
  });
});
