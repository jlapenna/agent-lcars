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
