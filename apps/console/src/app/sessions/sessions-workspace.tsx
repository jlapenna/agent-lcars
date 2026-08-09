import type { ReactNode } from 'react';

import { ConsoleWorkspace } from '../console-workspace';

/**
 * Responsive composition for the session archive. Query parsing, fetching,
 * grouping, and row rendering stay server-owned by page.tsx and its existing
 * children; this component only establishes the route-level operational
 * hierarchy shared by flat, grouped, empty, and warning states.
 */
export function SessionsWorkspace({
  warnings,
  toolbar,
  children,
}: {
  warnings?: ReactNode;
  toolbar: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel="Session archive"
      className="sessions-workspace"
      warnings={warnings}
      toolbar={toolbar}
    >
      <div className="sessions-workspace__content">{children}</div>
    </ConsoleWorkspace>
  );
}
