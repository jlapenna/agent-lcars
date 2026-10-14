import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleToolbar,
  ToolbarApply,
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
    // The primary action lives outside the filter form.
    expect(
      form.contains(screen.getByRole('button', { name: 'Respond to oldest' })),
    ).toBe(false);
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/inbox');
    expect(form.querySelector('input[name="item"]')).toHaveValue(
      'owner/repo#1',
    );
    expect(form.querySelector('input[name="empty"]')).toBeNull();
    // The checked window submits with every request, including Enter in Find.
    expect(screen.getByRole('radio', { name: '24h' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '1h' })).not.toBeChecked();
    expect(new FormData(form as HTMLFormElement).get('window')).toBe('24h');

    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: 'owner/repo' },
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Respond to oldest' }).parentElement,
    ).toHaveClass('console-toolbar__primary');
  });

  it('shows a native Apply until the controls hydrate', () => {
    render(
      <form>
        <ToolbarSelect
          name="repo"
          label="Repository"
          options={[{ value: '', label: 'All repositories (1)' }]}
        />
        <ToolbarApply />
      </form>,
    );
    // After the select's effect runs, CSS hides Apply inside this form.
    expect(
      screen.getByRole('button', { name: 'Apply' }).closest('form'),
    ).toHaveAttribute('data-hydrated');
  });

  it('draws a disabled window option that cannot be chosen and says why', () => {
    render(
      <ConsoleToolbar action="/shuttlebay">
        <ToolbarWindow
          name="window"
          label="Window"
          value="30m"
          options={[
            { value: '30m', label: '30m' },
            {
              value: '24h',
              label: '24h',
              disabled: true,
              title: 'Runner telemetry keeps the last 30 minutes',
            },
          ]}
        />
      </ConsoleToolbar>,
    );
    const day = screen.getByRole('radio', { name: '24h' });
    expect(day).toBeDisabled();
    expect(day).toHaveAccessibleDescription(
      'Runner telemetry keeps the last 30 minutes',
    );
    expect(day.closest('label')).toHaveAttribute(
      'title',
      'Runner telemetry keeps the last 30 minutes',
    );
    expect(screen.getByRole('radio', { name: '30m' })).toBeChecked();
  });
});
