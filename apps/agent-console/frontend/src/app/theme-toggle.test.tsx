import * as mantineCore from '@mantine/core';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { ThemeToggle } from './theme-toggle';

jest.mock('@mantine/core', () => {
  const originalModule = jest.requireActual('@mantine/core');
  return {
    ...originalModule,
    useMantineColorScheme: jest.fn(),
    useComputedColorScheme: jest.fn(),
  };
});

describe('ThemeToggle', () => {
  const setColorScheme = jest.fn();

  beforeEach(() => {
    (mantineCore.useMantineColorScheme as jest.Mock).mockReturnValue({
      setColorScheme,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders correctly', () => {
    (mantineCore.useComputedColorScheme as jest.Mock).mockReturnValue('light');
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
    (mantineCore.useComputedColorScheme as jest.Mock).mockReturnValue('light');
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
    (mantineCore.useComputedColorScheme as jest.Mock).mockReturnValue('dark');
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
