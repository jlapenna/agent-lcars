import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionRow } from '../../lib/session-archive';
import { SessionTable } from './session-table';

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'session-1',
    source: 'cli',
    title: 'Fix flaky login test',
    prUrls: [],
    turns: 4,
    totalTokens: 1500,
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    liveness: 'ended',
    ...overrides,
  };
}

function renderTable(rows: SessionRow[]) {
  render(
    <MantineProvider>
      <SessionTable rows={rows} />
    </MantineProvider>,
  );
}

describe('SessionTable', () => {
  it('renders an empty state with no rows', () => {
    renderTable([]);
    expect(screen.getByTestId('session-table-empty')).toBeTruthy();
  });

  it('links a row title to its session detail page', () => {
    renderTable([makeRow({ sessionId: 'abc-123' })]);
    const link = screen.getByRole('link', { name: 'Fix flaky login test' });
    expect(link.getAttribute('href')).toBe('/sessions/abc-123');
  });

  it('links the issue number when present', () => {
    renderTable([
      makeRow({
        source: 'issue-agent',
        issueNumber: 42,
        issueUrl: 'https://github.com/o/r/issues/42',
      }),
    ]);
    const link = screen.getByRole('link', { name: '#42' });
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/issues/42');
  });

  it('renders no issue link when the row has none', () => {
    renderTable([makeRow()]);
    expect(screen.queryByText('#42')).toBeNull();
  });

  it('links every PR number', () => {
    renderTable([
      makeRow({
        prUrls: [
          { number: 10, url: 'https://github.com/o/r/pull/10' },
          { number: 20, url: 'https://github.com/o/r/pull/20' },
        ],
      }),
    ]);
    expect(screen.getByRole('link', { name: '#10' }).getAttribute('href')).toBe(
      'https://github.com/o/r/pull/10',
    );
    expect(screen.getByRole('link', { name: '#20' }).getAttribute('href')).toBe(
      'https://github.com/o/r/pull/20',
    );
  });

  it('shows the host for a CLI session', () => {
    renderTable([makeRow({ source: 'cli', host: 'joes-workstation' })]);
    expect(screen.getByText('joes-workstation')).toBeTruthy();
  });

  it('links the run for an issue-agent session', () => {
    renderTable([
      makeRow({
        source: 'issue-agent',
        runId: '999',
        runUrl: 'https://github.com/o/r/actions/runs/999',
      }),
    ]);
    const link = screen.getByRole('link', { name: /run/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/o/r/actions/runs/999',
    );
  });

  it('shows a formatted cost when the row has one', () => {
    renderTable([makeRow({ sessionId: 's-cost', totalCostUsd: 1.5 })]);
    expect(screen.getByText('$1.50')).toBeTruthy();
  });

  it('shows an em-dash for cost when the row has none', () => {
    renderTable([makeRow({ sessionId: 's-no-cost' })]);
    expect(screen.queryByText('$')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the liveness badge with its label', () => {
    renderTable([makeRow({ liveness: 'live' })]);
    expect(screen.getByTestId('session-row-liveness').textContent).toBe('live');
  });

  it('formats total tokens with thousands separators', () => {
    renderTable([makeRow({ totalTokens: 12345 })]);
    expect(screen.getByText('12,345')).toBeTruthy();
  });
});
