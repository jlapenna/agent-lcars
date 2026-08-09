import type { ReactNode } from 'react';

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
    <section
      className="console-workspace sessions-workspace"
      aria-label="Session archive"
    >
      {warnings ? (
        <div className="sessions-workspace__warnings">{warnings}</div>
      ) : null}
      <div className="sessions-workspace__toolbar">{toolbar}</div>
      <div className="sessions-workspace__content">{children}</div>
    </section>
  );
}
