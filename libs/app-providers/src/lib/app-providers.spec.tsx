import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AppProviders from './app-providers';

describe('AppProviders', () => {
  it('should render successfully', () => {
    const { baseElement } = render(
      <AppProviders theme={{}}>
        <div>Test</div>
      </AppProviders>,
    );
    expect(baseElement).toBeTruthy();
  });
});
