import * as mantineCore from '@mantine/core';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { ThemeToggle } from './theme-toggle';

vi.mock('@mantine/core', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@mantine/core')>();
  return {
    ...originalModule,
    useMantineColorScheme: vi.fn(),
    useComputedColorScheme: vi.fn(),
  };
});

describe('ThemeToggle', () => {
  const setColorScheme = vi.fn();

  beforeEach(() => {
    (mantineCore.useMantineColorScheme as Mock).mockReturnValue({
      setColorScheme,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders correctly', () => {
    (mantineCore.useComputedColorScheme as Mock).mockReturnValue('light');
    render(
      <MantineProvider>
        <ThemeToggle />
      </MantineProvider>,
    );

    expect(
      screen.getByRole('button', { name: /toggle color scheme/i }),
    ).toBeTruthy();
  });

  it('toggles from light to dark and sets the SSR cookie', () => {
    (mantineCore.useComputedColorScheme as Mock).mockReturnValue('light');
    render(
      <MantineProvider>
        <ThemeToggle />
      </MantineProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /toggle color scheme/i }),
    );

    expect(setColorScheme).toHaveBeenCalledWith('dark');
    expect(document.cookie).toContain('mantine-color-scheme=dark');
  });

  it('toggles from dark to light', () => {
    (mantineCore.useComputedColorScheme as Mock).mockReturnValue('dark');
    render(
      <MantineProvider>
        <ThemeToggle />
      </MantineProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /toggle color scheme/i }),
    );

    expect(setColorScheme).toHaveBeenCalledWith('light');
  });
});
