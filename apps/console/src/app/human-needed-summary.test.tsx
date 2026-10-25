import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';

import { HumanNeededSummary } from './human-needed-summary';

it('renders model output as inert text and preserves multiline command excerpts', () => {
  const { container } = render(
    <MantineProvider>
      <HumanNeededSummary
        actions={[
          {
            text: '<script>steal()</script>',
            command: 'check --prod\necho "<img src=x onerror=steal()>"',
          },
          { text: 'Reply after checking.' },
        ]}
      />
    </MantineProvider>,
  );
  const summary = screen.getByRole('region', { name: 'Human work summary' });
  expect(within(summary).getAllByRole('listitem')).toHaveLength(2);
  expect(summary).toHaveTextContent('<script>steal()</script>');
  expect(summary.querySelector('pre')).toHaveTextContent('check --prod');
  expect(container.querySelector('script, img, button, a')).toBeNull();
});

it('keeps parked-run actions behind a historical disclosure without rewriting them', () => {
  const { container } = render(
    <MantineProvider>
      <HumanNeededSummary
        historical
        actions={[{ text: 'Rotate the key.', command: 'rotate --key old' }]}
      />
    </MantineProvider>,
  );
  const disclosure = container.querySelector('details');
  expect(disclosure).not.toHaveAttribute('open');
  expect(disclosure?.querySelector('summary')).toHaveTextContent(
    'Earlier handoff · AI summary',
  );
  expect(disclosure).toHaveTextContent(
    'Later comments may supersede these actions',
  );
  expect(disclosure?.querySelector('pre')).toHaveTextContent(
    'rotate --key old',
  );
});
