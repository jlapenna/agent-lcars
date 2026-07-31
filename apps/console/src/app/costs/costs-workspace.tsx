import type { ReactNode } from 'react';

/**
 * Route-level composition for the cost ledger. Data fetching, aggregation,
 * empty states, and estimate disclosure remain owned by the existing server
 * components; this shell only establishes the shared responsive workspace
 * hierarchy.
 */
export function CostsWorkspace({
  warnings,
  children,
}: {
  warnings?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="costs-workspace" aria-label="Cost ledger">
      {warnings ? (
        <div className="costs-workspace__warnings">{warnings}</div>
      ) : null}
      <div className="costs-workspace__content">{children}</div>
    </section>
  );
}
