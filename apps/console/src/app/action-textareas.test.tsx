import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RetriggerButton } from './retrigger-button';
import { UnstickPrsButton } from './unstick-prs-button';

vi.mock('./actions', () => ({
  dispatchUnstickPrs: vi.fn(),
  retriggerIssue: vi.fn(),
}));

function renderAction(action: React.ReactNode) {
  return render(<MantineProvider>{action}</MantineProvider>);
}

describe('action textarea labels', () => {
  it('labels the optional retrigger steering note without changing its name', async () => {
    renderAction(
      <RetriggerButton repo={{ owner: 'o', name: 'r' }} issueNumber={42} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retrigger' }));

    expect(
      await screen.findByRole('textbox', {
        name: 'Optional steering note — posted on the issue before the fresh run starts',
      }),
    ).toBeTruthy();
  });

  it('labels the optional unstick context without changing its name', async () => {
    renderAction(<UnstickPrsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Run unstick-prs' }));

    expect(
      await screen.findByRole('textbox', {
        name: 'Optional context — PR numbers, symptoms — posted on the anchor issue',
      }),
    ).toBeTruthy();
  });
});
