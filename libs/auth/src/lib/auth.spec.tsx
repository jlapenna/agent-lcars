import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Auth from './auth';

describe('Auth', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<Auth />);
    expect(baseElement).toBeTruthy();
  });
});
