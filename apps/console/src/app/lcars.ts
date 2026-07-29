import type { CSSProperties } from 'react';

/**
 * The nav-destination identity colors (matches the pill rail in
 * console-header.tsx). Top-level panel shells on a page pick up that same
 * page's accent via the `.lcars-panel` elbow treatment, so "which color am
 * I in" stays one consistent signal across the pill nav and the panels
 * beneath it — never a decorative per-card color unrelated to the page.
 */
const LCARS_ACCENT = {
  amber: 'var(--mantine-color-orange-6)',
  periwinkle: 'var(--mantine-color-violet-5)',
  teal: 'var(--mantine-color-teal-6)',
  gold: 'var(--mantine-color-yellow-5)',
} as const;

export function lcarsPanelStyle(
  accent: keyof typeof LCARS_ACCENT,
): CSSProperties {
  return { '--lcars-accent': LCARS_ACCENT[accent] } as CSSProperties;
}
