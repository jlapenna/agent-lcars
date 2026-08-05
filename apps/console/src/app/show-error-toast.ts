import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';

/** Shows an error until the user has had time to read, copy, and dismiss it. */
export function showErrorToast(message: ReactNode): void {
  notifications.show({
    message,
    color: 'red',
    autoClose: false,
    withCloseButton: true,
  });
}
