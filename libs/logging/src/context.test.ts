import { getContext, RequestContext, runWithContext } from './context';

describe('RequestContext', () => {
  it('should return undefined when no context is active', () => {
    expect(getContext()).toBeUndefined();
  });

  it('should return context within runWithContext', () => {
    const context: RequestContext = { path: '/test' };
    runWithContext(context, () => {
      expect(getContext()).toEqual(context);
    });
  });

  it('should isolate context between runs', () => {
    const context1: RequestContext = { path: '/test1' };
    const context2: RequestContext = { path: '/test2' };

    runWithContext(context1, () => {
      expect(getContext()).toEqual(context1);
    });

    runWithContext(context2, () => {
      expect(getContext()).toEqual(context2);
    });

    expect(getContext()).toBeUndefined();
  });

  it('should support nested contexts', () => {
    const parent: RequestContext = { path: '/parent' };
    const child: RequestContext = { path: '/child' };

    runWithContext(parent, () => {
      expect(getContext()).toEqual(parent);
      runWithContext(child, () => {
        expect(getContext()).toEqual(child);
      });
      // Should restore parent context
      expect(getContext()).toEqual(parent);
    });
  });

  it('should allow modifying context within run', () => {
    const context: RequestContext = { path: '/initial' };
    runWithContext(context, () => {
      const current = getContext();
      expect(current).toBeDefined();
      if (current) {
        current.slackUserId = 'U123';
      }
      expect(getContext()?.slackUserId).toBe('U123');
    });
    // Modification shouldn't affect original object reference if accessed outside (it's the same object)
    // but context storage is gone.
    expect(context.slackUserId).toBe('U123');
  });
});
