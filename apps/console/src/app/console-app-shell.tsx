import type { ReactNode } from 'react';

import { ConsoleHeader, type ConsoleHeaderProps } from './console-header';
import { ConsolePageShell } from './console-page-shell';

/**
 * The complete structural frame for every authenticated console route.
 *
 * This intentionally remains a Server Component: pages can stream their data
 * through `children` without making the page frame or data loading depend on
 * browser state. `ConsoleHeader` keeps its own small client boundary for the
 * interactive navigation controls.
 */
export function ConsoleAppShell({
  className,
  children,
  footer,
  ...header
}: ConsoleHeaderProps & {
  className?: string;
  children: ReactNode;
  /** Route-specific controls that belong below the main page content. */
  footer?: ReactNode;
}) {
  return (
    <ConsolePageShell className={className}>
      <ConsoleHeader {...header} />
      <main className="console-page-content">{children}</main>
      {footer}
    </ConsolePageShell>
  );
}
