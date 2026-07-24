import { Text, type TextProps } from '@mantine/core';

/**
 * The recurring micro-header idiom used across the console (section
 * eyebrows, field labels): dimmed, small, uppercase. Promoted to the
 * display face here so it carries the LCARS-panel-label character
 * consistently instead of each call site repeating the same prop bundle.
 */
export function Eyebrow({ children, ...props }: TextProps) {
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
