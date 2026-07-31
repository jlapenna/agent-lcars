import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SessionsWorkspace } from './sessions-workspace';

describe('SessionsWorkspace', () => {
  it('keeps warnings, view controls, and archive content in operational order', () => {
    render(
      <SessionsWorkspace
        warnings={<p>Partial data</p>}
        toolbar={<button type="button">By issue</button>}
      >
        <p>Archive rows</p>
      </SessionsWorkspace>,
    );

    const workspace = screen.getByRole('region', { name: 'Session archive' });
    expect(workspace.textContent).toBe('Partial dataBy issueArchive rows');
    expect(
      workspace.querySelector('.sessions-workspace__toolbar')?.textContent,
    ).toBe('By issue');
    expect(
      workspace.querySelector('.sessions-workspace__content')?.textContent,
    ).toBe('Archive rows');
  });

  it('does not render warning chrome when there are no warnings', () => {
    const { container } = render(
      <SessionsWorkspace toolbar={<p>Flat</p>}>
        <p>Archive rows</p>
      </SessionsWorkspace>,
    );

    expect(container.querySelector('.sessions-workspace__warnings')).toBeNull();
  });
});
