import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactPreviewToggle, classifyArtifact } from './artifact-viewer';

// react-markdown/remark-gfm are ESM-only (unified ecosystem) - stubbed here
// rather than added to the jest.config esmModules allowlist, matching the
// existing pattern in agent-activity-panel.test.tsx for ESM-only deps.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-stub">{children}</div>
  ),
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

describe('classifyArtifact', () => {
  it.each([
    ['report.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['chart.png', 'image'],
    ['photo.JPG', 'image'],
    ['diagram.svg', 'image'],
    ['summary.pdf', 'pdf'],
    ['data.json', 'other'],
    ['no-extension', 'other'],
  ])('classifies %s as %s', (filename, expected) => {
    expect(classifyArtifact(filename)).toBe(expected);
  });
});

function renderToggle(
  filename: string,
  url = 'https://share.lan.jlapenna.net/host/session/' + filename,
) {
  return render(
    <MantineProvider>
      <ArtifactPreviewToggle url={url} filename={filename} />
    </MantineProvider>,
  );
}

describe('ArtifactPreviewToggle', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders nothing for file types outside the preview scope', () => {
    renderToggle('data.json');
    expect(screen.queryByTestId('artifact-toggle-data.json')).toBeNull();
  });

  it('renders a collapsed toggle for a markdown artifact', () => {
    renderToggle('report.md');
    expect(screen.getByTestId('artifact-toggle-report.md')).toBeTruthy();
    expect(screen.queryByTestId('artifact-preview-report.md')).toBeNull();
  });

  it('fetches and renders markdown content when toggled open', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('# Hello artifact'),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderToggle('report.md');
    fireEvent.click(screen.getByTestId('artifact-toggle-report.md'));

    const stub = await screen.findByTestId('markdown-stub');
    expect(stub.textContent).toBe('# Hello artifact');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://share.lan.jlapenna.net/host/session/report.md',
    );
  });

  it('shows an error message when the markdown fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;

    renderToggle('report.md');
    fireEvent.click(screen.getByTestId('artifact-toggle-report.md'));

    expect(
      await screen.findByText(/Failed to load artifact: 404 Not Found/),
    ).toBeTruthy();
  });

  it('renders an image artifact inline when toggled open', () => {
    renderToggle('chart.png');
    fireEvent.click(screen.getByTestId('artifact-toggle-chart.png'));

    const img = screen.getByAltText('chart.png') as HTMLImageElement;
    expect(img.src).toBe(
      'https://share.lan.jlapenna.net/host/session/chart.png',
    );
  });

  it('renders a sandboxed iframe for a PDF artifact when toggled open', () => {
    renderToggle('summary.pdf');
    fireEvent.click(screen.getByTestId('artifact-toggle-summary.pdf'));

    const iframe = screen.getByTitle('summary.pdf') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.src).toBe(
      'https://share.lan.jlapenna.net/host/session/summary.pdf',
    );
  });
});
