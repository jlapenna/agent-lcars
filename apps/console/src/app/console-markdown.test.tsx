import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConsoleMarkdown } from './console-markdown';

describe('ConsoleMarkdown', () => {
  it('hides block and inline HTML comments as GitHub does', () => {
    const { container } = render(
      <ConsoleMarkdown>
        {'close it <!-- inline -->\n\n<!-- agent-lcars:console-reply -->'}
      </ConsoleMarkdown>,
    );
    expect(container.textContent?.trim()).toBe('close it');
  });

  it('keeps text between two comments on one line', () => {
    const { container } = render(
      <ConsoleMarkdown>{'<!-- a --> keep me <!-- b -->'}</ConsoleMarkdown>,
    );
    expect(container.textContent).toContain('keep me');
  });

  it('hides a multi-line comment and keeps what follows', () => {
    const { container } = render(
      <ConsoleMarkdown>{'<!-- a\nb -->\nafter'}</ConsoleMarkdown>,
    );
    expect(container.textContent?.trim()).toBe('after');
  });

  it('keeps a comment quoted as code', () => {
    const { container } = render(
      <ConsoleMarkdown>{'Use `<!-- marker -->` here.'}</ConsoleMarkdown>,
    );
    expect(container.textContent).toContain('<!-- marker -->');
  });

  it('still escapes other raw HTML', () => {
    const { container } = render(
      <ConsoleMarkdown>{'<b>bold</b> <!-- gone -->'}</ConsoleMarkdown>,
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>');
    expect(container.textContent).not.toContain('gone');
  });
});
