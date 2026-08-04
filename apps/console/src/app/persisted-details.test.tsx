import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { PersistedDetails } from './persisted-details';

const KEY = 'agent-lcars:disclosure:test:section';

function renderDisclosure(
  props: Partial<Parameters<typeof PersistedDetails>[0]> = {},
) {
  return render(
    <PersistedDetails
      storageKey="test:section"
      data-testid="disclosure"
      summary="Section"
      {...props}
    >
      <p>content</p>
    </PersistedDetails>,
  );
}

describe('PersistedDetails', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists a toggle and restores it on the next mount', () => {
    const first = renderDisclosure();
    const details = screen.getByTestId('disclosure');
    expect(details).not.toHaveAttribute('open');

    fireEvent(details, new Event('toggle'));
    // jsdom does not flip the attribute itself; simulate the browser toggle.
    (details as HTMLDetailsElement).open = true;
    fireEvent(details, new Event('toggle'));
    expect(window.localStorage.getItem(KEY)).toBe('1');
    first.unmount();

    renderDisclosure();
    expect(screen.getByTestId('disclosure')).toHaveAttribute('open');
  });

  it('without a storageKey stays pinned to defaultOpen and stores nothing', () => {
    window.localStorage.setItem(KEY, '0');
    renderDisclosure({ storageKey: undefined, defaultOpen: true });
    expect(screen.getByTestId('disclosure')).toHaveAttribute('open');
    expect(window.localStorage.getItem(KEY)).toBe('0');
  });

  it('reopens when props switch to the pinned anomaly mode mid-session', () => {
    window.localStorage.setItem(KEY, '0');
    const view = renderDisclosure();
    expect(screen.getByTestId('disclosure')).not.toHaveAttribute('open');

    // router.refresh() preserves client state; the anomaly transition
    // arrives as a prop change, not a remount.
    view.rerender(
      <PersistedDetails
        storageKey={undefined}
        defaultOpen
        data-testid="disclosure"
        summary="Section"
      >
        <p>content</p>
      </PersistedDetails>,
    );
    expect(screen.getByTestId('disclosure')).toHaveAttribute('open');
  });

  it('degrades to the default when nothing is stored', () => {
    renderDisclosure({ defaultOpen: true });
    expect(screen.getByTestId('disclosure')).toHaveAttribute('open');
  });
});
