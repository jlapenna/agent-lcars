import { isAuthEnabled, isE2eTesting, isOnecakeAdmin } from './env';

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
    process.env['E2E_TESTING'] = 'true';
    expect(isE2eTesting()).toBe(true);
  });

  it('isAuthEnabled returns true when AUTH_ENABLED is true', () => {
    process.env['AUTH_ENABLED'] = 'true';
    process.env['E2E_TESTING'] = 'false';
    expect(isAuthEnabled()).toBe(true);
  });

  describe('isOnecakeAdmin', () => {
    beforeEach(() => {
      process.env['ONECAKE_ADMINS'] = '66304';
    });

    it('matches a string athlete id on the allowlist', () => {
      expect(isOnecakeAdmin('66304')).toBe(true);
    });

    // Auth.js account docs store providerAccountId numerically; the gate must
    // not throw `athleteId.trim is not a function` on a numeric id.
    it('matches a numeric athlete id on the allowlist', () => {
      expect(isOnecakeAdmin(66304)).toBe(true);
    });

    it('rejects an athlete id not on the allowlist', () => {
      expect(isOnecakeAdmin(12345)).toBe(false);
      expect(isOnecakeAdmin('12345')).toBe(false);
    });
  });
});
