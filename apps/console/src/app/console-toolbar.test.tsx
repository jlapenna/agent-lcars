import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
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

  it('applies the filters when focus leaves them for the page, not for another control', () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'requestSubmit')
      .mockImplementation(() => undefined);
    render(
      <>
        <ConsoleToolbar action="/work">
          <ToolbarSearch name="q" label="Find" placeholder="title" />
          <input aria-label="Principal" name="principal" />
        </ConsoleToolbar>
        <button type="button">New work</button>
      </>,
    );
    const find = screen.getByRole('searchbox', { name: 'Find' });
    const principal = screen.getByRole('textbox', { name: 'Principal' });

    fireEvent.change(find, { target: { value: 'healthz' } });
    // On to another filter: nothing yet.
    fireEvent.focusOut(find, { relatedTarget: principal });
    // Out to another action: it runs; no reload races it.
    fireEvent.change(principal, { target: { value: 'user:jlapenna' } });
    fireEvent.focusOut(principal, {
      relatedTarget: screen.getByRole('button', { name: 'New work' }),
    });
    expect(submit).not.toHaveBeenCalled();
    // Out to the page from a sibling filter: both edits apply.
    fireEvent.focusOut(principal, { relatedTarget: null });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('applies a cleared FIND and ignores an unchanged one', () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'requestSubmit')
      .mockImplementation(() => undefined);
    render(
      <ConsoleToolbar action="/agents">
        <ToolbarSearch name="q" label="Find" placeholder="issue" value="x" />
      </ConsoleToolbar>,
    );
    const find = screen.getByRole('searchbox', { name: 'Find' });
    fireEvent.focusOut(find, { relatedTarget: null });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(find, { target: { value: '' } });
    fireEvent(find, new Event('search'));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('folds the filters behind a toggle that counts active selects', () => {
    render(
      <ConsoleToolbar action="/agents">
        <ToolbarSelect
          name="agent"
          label="Agent"
          value="codex"
          options={[
            { value: '', label: 'All agents' },
            { value: 'codex', label: 'codex' },
          ]}
        />
        <ToolbarSearch name="q" label="Find" placeholder="issue" />
      </ConsoleToolbar>,
    );
    const form = screen.getByRole('search', { name: 'Filters' });
    const toggle = screen.getByRole('button', { name: 'Filters · 1' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(form).not.toHaveAttribute('data-open');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(form).toHaveAttribute('data-open');
  });

  it('offers Apply only to browsers without JavaScript', () => {
    // Server markup carries it inside <noscript>; a scripted page never lays
    // it out, so hydrating moves nothing.
    expect(renderToStaticMarkup(<ToolbarApply />)).toBe(
      '<noscript><button type="submit" class="console-toolbar__apply">Apply</button></noscript>',
    );
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
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
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
            { value: '24h', label: '24h', disabled: true },
          ]}
          note="Runner telemetry keeps the last 30 minutes"
        />
      </ConsoleToolbar>,
    );
    const day = screen.getByRole('radio', { name: '24h' });
    expect(day).toBeDisabled();
    expect(day).toHaveAccessibleDescription(
      'Runner telemetry keeps the last 30 minutes',
    );
    // Visible, not only described: a disabled radio cannot take focus.
    expect(
      screen.getByText('Runner telemetry keeps the last 30 minutes'),
    ).toBeVisible();
    expect(screen.getByRole('radio', { name: '30m' })).toBeChecked();
  });
});
