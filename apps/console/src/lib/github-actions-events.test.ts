import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { publishActionsEvent } from './github-actions-events';

describe('publishActionsEvent', () => {
  it('publishes the raw signed body with identifying attributes', async () => {
    const publish = vi.fn().mockResolvedValue('message-7');
    const rawBody = Buffer.from('{"action":"completed"}');
    await expect(
      publishActionsEvent(
        {
          rawBody,
          deliveryId: 'd-1',
          eventName: 'workflow_job',
          repository: 'jlapenna/homelab',
        },
        { publish },
      ),
    ).resolves.toEqual({
      deliveryId: 'd-1',
      outcome: 'published',
      messageId: 'message-7',
    });
    expect(publish).toHaveBeenCalledWith(rawBody, {
      event: 'workflow_job',
      delivery_id: 'd-1',
      repository: 'jlapenna/homelab',
    });
  });

  it('propagates publish failures', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('unavailable'));
    await expect(
      publishActionsEvent(
        {
          rawBody: Buffer.from('{}'),
          deliveryId: 'd-2',
          eventName: 'workflow_run',
          repository: 'jlapenna/homelab',
        },
        { publish },
      ),
    ).rejects.toThrow('unavailable');
  });
});
