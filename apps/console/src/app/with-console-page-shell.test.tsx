import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { withConsolePageShell } from './with-console-page-shell';

describe('withConsolePageShell', () => {
  it('owns one shared header and injects per-view customizations', () => {
    function SessionView({ sessionId }: { sessionId: string }) {
      return <p>Transcript for {sessionId}</p>;
    }

    const SessionPage = withConsolePageShell(SessionView, ({ sessionId }) => ({
      current: 'sessions',
      title: `Session ${sessionId}`,
      subtitle: 'CLI session',
    }));

    const { container } = render(
      <MantineProvider>
        <SessionPage sessionId="abc123" />
      </MantineProvider>,
    );

    expect(container.querySelectorAll('.console-header')).toHaveLength(1);
    expect(
      screen.getByRole('heading', { name: 'Session abc123' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('navigation', { name: 'Console sections' }),
    ).toBeTruthy();
    expect(screen.getByRole('main')).toHaveTextContent('Transcript for abc123');
  });
});
