import type { ReactNode } from 'react';

import { ConsoleWorkspace } from '../console-workspace';

/**
 * Route-level composition for the cost ledger. Data fetching, aggregation,
 * empty states, and estimate disclosure remain owned by the existing server
 * components; this shell only establishes the shared responsive workspace
 * hierarchy.
 */
export function CostsWorkspace({
  warnings,
  toolbar,
  children,
}: {
  warnings?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel="Cost ledger"
      className="costs-workspace"
      warnings={warnings}
      toolbar={toolbar}
    >
      <div className="costs-workspace__content">{children}</div>
    </ConsoleWorkspace>
  );
}
