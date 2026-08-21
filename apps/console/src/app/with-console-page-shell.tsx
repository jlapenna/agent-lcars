import type { ComponentType } from 'react';

import {
  ConsoleAppShell,
  type ConsoleAppShellProps,
} from './console-app-shell';

export type ConsolePageShellCustomization = Omit<
  ConsoleAppShellProps,
  'children'
>;

/**
 * Makes the shared console header structural rather than an opt-in detail of
 * each page. Route components supply only their view-specific title, active
 * destination, utilities, and footer; this wrapper owns the one
 * `ConsoleAppShell`/`ConsoleHeader` instance around their content.
 *
 * Keep this wrapper client-safe. Most callers are Server Components, while
 * `error.tsx` is a client boundary and must inherit the exact same frame.
 */
export function withConsolePageShell<Props extends object>(
  PageContent: ComponentType<Props>,
  customization:
    | ConsolePageShellCustomization
    | ((props: Props) => ConsolePageShellCustomization),
) {
  function ConsolePageWithShell(props: Props) {
    const shell =
      typeof customization === 'function'
        ? customization(props)
        : customization;

    return (
      <ConsoleAppShell {...shell}>
        <PageContent {...props} />
      </ConsoleAppShell>
    );
  }

  ConsolePageWithShell.displayName = `withConsolePageShell(${PageContent.displayName ?? PageContent.name ?? 'PageContent'})`;
  return ConsolePageWithShell;
}
