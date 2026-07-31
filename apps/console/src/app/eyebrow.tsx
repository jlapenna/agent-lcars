import { Text, type TextProps } from '@mantine/core';
import type { PropsWithChildren } from 'react';

type EyebrowProps = PropsWithChildren<
  TextProps & {
    component?: 'span';
  }
>;

/**
 * The recurring micro-header idiom used across the console (section
 * eyebrows, field labels): dimmed, small, uppercase. Promoted to the
 * display face here so it carries the LCARS-panel-label character
 * consistently instead of each call site repeating the same prop bundle.
 */
export function Eyebrow({ children, ...props }: EyebrowProps) {
  return (
    <Text
      size="xs"
      c="dimmed"
      fw={600}
      tt="uppercase"
      className="lcars-eyebrow"
      {...props}
    >
      {children}
    </Text>
  );
}
