import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QUICK_TASK_EVIDENCE_DISCLOSURE_WARNING } from '../lib/quick-task-evidence-contract';
import { QuickTaskScreenshotField } from './quick-task-screenshot-field';

function PickerHarness() {
  const [file, setFile] = useState<File>();
  return <QuickTaskScreenshotField value={file} onChange={setFile} />;
}

function renderPicker() {
  render(
    <MantineProvider>
      <PickerHarness />
    </MantineProvider>,
  );
}

function image(name = 'screenshot.png', type = 'image/png') {
  return new File(['image'], name, { type });
}

describe('QuickTaskScreenshotField', () => {
  afterEach(() => vi.restoreAllMocks());

  it('always shows the outside-GitHub-access warning and accepted formats', () => {
    renderPicker();
    expect(
      screen.getByText(QUICK_TASK_EVIDENCE_DISCLOSURE_WARNING),
    ).toBeTruthy();
    expect(screen.getByLabelText('Screenshot (optional)')).toHaveAttribute(
      'accept',
      'image/png,image/jpeg,image/webp',
    );
    expect(screen.getByLabelText('Screenshot (optional)')).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('accepts a chosen file and cleans up its preview URL when removed', () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    renderPicker();

    fireEvent.change(screen.getByLabelText('Screenshot (optional)'), {
      target: { files: [image()] },
    });

    expect(
      screen.getByAltText('Screenshot preview: screenshot.png'),
    ).toHaveAttribute('src', 'blob:preview');
    const inputClick = vi.spyOn(
      screen.getByLabelText('Screenshot (optional)'),
      'click',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(inputClick).not.toHaveBeenCalled();
  });

  it('accepts a pasted or dropped image and replaces the prior file', () => {
    const onChange = vi.fn();
    render(
      <MantineProvider>
        <QuickTaskScreenshotField onChange={onChange} />
      </MantineProvider>,
    );
    const target = screen.getByRole('button', {
      name: 'Paste or drop a screenshot',
    });
    fireEvent.paste(target, {
      clipboardData: { files: [image('paste.webp', 'image/webp')] },
    });
    fireEvent.drop(target, {
      dataTransfer: { files: [image('drop.jpg', 'image/jpeg')] },
    });

    expect(onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'paste.webp' }),
    );
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'drop.jpg' }),
    );
  });

  it('rejects unsupported and oversized files before handing them to its parent', () => {
    const onChange = vi.fn();
    render(
      <MantineProvider>
        <QuickTaskScreenshotField onChange={onChange} />
      </MantineProvider>,
    );
    const input = screen.getByLabelText('Screenshot (optional)');
    fireEvent.change(input, {
      target: { files: [image('unsafe.svg', 'image/svg+xml')] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('PNG, JPEG, or WebP');
    expect(onChange).not.toHaveBeenCalled();
  });
});
