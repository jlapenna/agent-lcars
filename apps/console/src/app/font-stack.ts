export type LoadedFont = { style: { fontFamily: string } };

/** `core, extended, core's metric-adjusted fallback`. */
export function fontStack(coreFont: LoadedFont, extFont: LoadedFont): string {
  // next/font family names are quoted and never contain a comma.
  const [primary, ...fallbacks] = coreFont.style.fontFamily.split(',');
  return [primary, extFont.style.fontFamily, ...fallbacks]
    .map((family) => family.trim())
    .join(', ');
}
