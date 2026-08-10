import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GlobalError from './error';

describe('GlobalError', () => {
  const reset = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the generic error message and retries via reset()', () => {
    render(
      <MantineProvider>
        <GlobalError error={new Error('boom')} reset={reset} />
      </MantineProvider>,
    );

    expect(
      screen.getAllByRole('heading', { name: 'Something went wrong' }),
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalled();
  });

  it('renders a stale-deploy message and does not reset() for UnrecognizedActionError', () => {
    render(
      <MantineProvider>
        <GlobalError
          error={new UnrecognizedActionError('Server Action was not found')}
          reset={reset}
        />
      </MantineProvider>,
    );

    expect(
      screen.getAllByRole('heading', { name: 'Console was updated' }),
    ).toHaveLength(2);
    expect(screen.getByText(/redeployed under this tab/i)).toBeTruthy();

    // jsdom cannot mock window.location.reload (it's non-configurable), so
    // this only asserts the stale-deploy path is taken instead of reset().
    fireEvent.click(screen.getByRole('button', { name: /reload page/i }));

    expect(reset).not.toHaveBeenCalled();
  });
});
