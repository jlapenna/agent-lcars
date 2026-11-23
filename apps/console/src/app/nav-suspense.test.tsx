import { act, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { NavSuspense } from './nav-suspense';

const pending = new Promise<never>(() => undefined);
function Suspends(): never {
  throw pending;
}

describe('NavSuspense', () => {
  it('leaves a client-mounted subtree to the boundary already on screen', () => {
    // A client navigation mounts pages fresh. With no boundary of its own,
    // the suspension reaches a revealed ancestor, so the router's transition
    // keeps the current page instead of committing a skeleton.
    render(
      <Suspense fallback="outer fallback">
        <NavSuspense fallback="page skeleton">
          <Suspends />
        </NavSuspense>
      </Suspense>,
    );

    expect(screen.getByText('outer fallback')).toBeTruthy();
    expect(screen.queryByText('page skeleton')).toBeNull();
  });

  it('hydrates the streamed boundary the server rendered', async () => {
    const tree = (
      <NavSuspense fallback="page skeleton">
        <span>page content</span>
      </NavSuspense>
    );
    const html = renderToString(tree);
    // React's markers for a resolved Suspense boundary.
    expect(html).toContain('<!--$-->');

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    await act(async () => {
      hydrateRoot(container, tree, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toBe('page content');
    container.remove();
  });
});
