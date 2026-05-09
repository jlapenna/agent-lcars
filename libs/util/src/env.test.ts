import { isAuthEnabled, isE2eTesting } from './env';

describe('env', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('isE2eTesting returns true when E2E_TESTING is true', () => {
    process.env.E2E_TESTING = 'true';
    expect(isE2eTesting()).toBe(true);
  });

  it('isAuthEnabled returns true when AUTH_ENABLED is true', () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.E2E_TESTING = 'false';
    expect(isAuthEnabled()).toBe(true);
  });
});
