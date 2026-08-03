import { getDefaultZIndex } from '@mantine/core';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AppProviders from './app-providers';

describe('AppProviders', () => {
  it('should render successfully', () => {
    const { baseElement } = render(
      <AppProviders theme={{}}>
        <div>Test</div>
      </AppProviders>,
    );
    expect(baseElement).toBeTruthy();
  });

  // agent-lcars#266: Mantine's own Notifications default z-index (the
  // 'overlay' tier, 400) sits ABOVE the modal tier (200), so a toast still
  // showing when a dialog opens renders on top of it and can intercept
  // clicks meant for the dialog. Every notifications root must render below
  // the modal tier so an open dialog is never blocked by a stray toast.
  it('renders notifications below the modal z-index tier', () => {
    const { baseElement } = render(
      <AppProviders theme={{}}>
        <div>Test</div>
      </AppProviders>,
    );

    const roots = baseElement.querySelectorAll('.mantine-Notifications-root');
    expect(roots.length).toBeGreaterThan(0);
    roots.forEach((root) => {
      const zIndex = Number(
        (root as HTMLElement).style.getPropertyValue('--notifications-z-index'),
      );
      expect(zIndex).toBeLessThan(getDefaultZIndex('modal'));
    });
  });
});
