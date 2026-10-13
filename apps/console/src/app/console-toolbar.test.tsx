import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleToolbar,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarWindow,
} from './console-toolbar';

describe('ConsoleToolbar', () => {
  afterEach(() => cleanup());

  it('carries preserved URL state and submits a select change as a GET', () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'requestSubmit')
      .mockImplementation(() => undefined);
    render(
      <ConsoleToolbar
        action="/inbox"
        preserve={{ item: 'owner/repo#1', empty: undefined }}
        primary={<button type="button">Respond to oldest</button>}
      >
        <ToolbarSelect
          name="repo"
          label="Repository"
          value=""
          options={[
            { value: '', label: 'All repositories (2)' },
            { value: 'owner/repo', label: 'owner/repo' },
          ]}
        />
        <ToolbarWindow
          name="window"
          label="Window"
          value="24h"
          options={[
            { value: '1h', label: '1h' },
            { value: '24h', label: '24h' },
          ]}
        />
        <ToolbarSearch
          name="q"
          label="Search"
          placeholder="issue, PR, session id"
        />
      </ConsoleToolbar>,
    );

    const form = screen.getByRole('search', { name: 'Filters' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/inbox');
    expect(form.querySelector('input[name="item"]')).toHaveValue(
      'owner/repo#1',
    );
    expect(form.querySelector('input[name="empty"]')).toBeNull();
    expect(screen.getByRole('button', { name: '24h' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: 'owner/repo' },
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Respond to oldest' }).parentElement,
    ).toHaveClass('console-toolbar__primary');
  });
});
