import { describe, expect, it } from 'vitest';

import { AuthJsAccountSchema, AuthJsUserSchema } from './schema';

describe('auth-schema', () => {
  describe('Account', () => {
    it('valid', () => {
      const account = {
        userId: 'user-123',
        type: 'oauth',
        provider: 'strava',
        providerAccountId: 'athlete-456',
        access_token: 'abc',
        refresh_token: 'def',
        expires_at: 1700000000,
        token_type: 'Bearer',
        scope: 'read,activity:read',
      };

      const result = AuthJsAccountSchema.safeParse(account);
      expect(result.success).toBe(true);
    });

    it('invalid-missing-fields', () => {
      const account = {
        userId: 'user-123',
        // missing type, provider, providerAccountId
      };

      const result = AuthJsAccountSchema.safeParse(account);
      expect(result.success).toBe(false);
    });
  });

  describe('User', () => {
    it('valid-slack', () => {
      const user = {
        name: 'John Doe',
        email: 'john@example.com',
        slack: {
          id: 'U123456',
          teamId: 'T123456',
          isAdmin: true,
        },
      };

      const result = AuthJsUserSchema.safeParse(user);
      expect(result.success).toBe(true);
    });
  });
});
