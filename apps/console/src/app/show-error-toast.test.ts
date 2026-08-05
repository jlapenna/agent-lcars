import { notifications } from '@mantine/notifications';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showErrorToast } from './show-error-toast';

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

describe('showErrorToast', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps errors visible until explicitly dismissed', () => {
    showErrorToast('Repository rule violations found');

    expect(notifications.show).toHaveBeenCalledWith({
      message: 'Repository rule violations found',
      color: 'red',
      autoClose: false,
      withCloseButton: true,
    });
  });
});
