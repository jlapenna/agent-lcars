import { Context, NextFn } from '@slack/bolt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bindBoltContext, getContext, runWithContext } from './context';

// Mock getContext and runWithContext is NOT needed if we use the real ones from ./context
// The original test mocked it to requireActual, which effectively does nothing but ensure it's not automocked?
// Jest usually doesn't automock node_modules unless configured.
// But specific path imports might differ.
// In shared lib, we simply import from ./context.

describe('bind-context', () => {
  describe('bindBoltContext', () => {
    let mockNext: NextFn;

    beforeEach(() => {
      mockNext = vi.fn().mockResolvedValue(undefined);
    });

    it('should extract userId from boltContext.botUserId', async () => {
      const args = {
        context: { botUserId: 'U_BOT' } as Context,
        body: {},
        next: mockNext,
      };

      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.userId).toBe('U_BOT');
      });
      expect(mockNext).toHaveBeenCalled();
    });

    it('should extract userId from boltContext.userToken', async () => {
      // Note: As noted in original test, userToken usage as ID might be questionable but preserving logic.
      const args = {
        context: { userToken: 'U_TOKEN_USER' } as Context,
        body: {},
        next: mockNext,
      };

      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.userId).toBe('U_TOKEN_USER');
      });
    });

    it('should extract from body.user.id', async () => {
      const args = {
        context: {} as Context,
        body: { user: { id: 'U_BODY' } },
        next: mockNext,
      };

      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.userId).toBe('U_BODY');
      });
    });

    it('should extract from body.user_id (SlashCommand)', async () => {
      const args = {
        context: {} as Context,
        body: { user_id: 'U_BODY_ID', command: '/test' },
        next: mockNext,
      };

      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.userId).toBe('U_BODY_ID');
      });
    });

    it('should create new context if none exists', async () => {
      const args = {
        context: { botUserId: 'U_NEW' } as Context,
        body: {},
        next: mockNext,
      };

      // Called WITHOUT existing runWithContext
      // This will create a new context scope for `next`
      const checkContextNext = vi.fn().mockImplementation(() => {
        expect(getContext()?.userId).toBe('U_NEW');
        return Promise.resolve();
      });

      await bindBoltContext({ ...args, next: checkContextNext });
      expect(checkContextNext).toHaveBeenCalled();
    });

    it('should extract action from slash command', async () => {
      const args = {
        context: {} as Context,
        body: { command: '/test-command' },
        next: mockNext,
      };
      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.action).toBe('/test-command');
      });
    });

    it('should extract action from event type', async () => {
      const args = {
        context: {} as Context,
        body: { event: { type: 'app_home_opened' } },
        next: mockNext,
      };
      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.action).toBe('app_home_opened');
      });
    });

    it('should extract action from block_actions', async () => {
      const args = {
        context: {} as Context,
        body: {
          type: 'block_actions',
          actions: [{ action_id: 'button_click' }],
        },
        next: mockNext,
      };
      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.action).toBe('button_click');
      });
    });

    it('should extract action from view_submission', async () => {
      const args = {
        context: {} as Context,
        body: {
          type: 'view_submission',
          view: { callback_id: 'view_callback' },
        },
        next: mockNext,
      };
      await runWithContext({}, async () => {
        await bindBoltContext(args);
        expect(getContext()?.action).toBe('view_callback');
      });
    });
  });
});
