import type { ReactNode } from 'react';

/** Shared LCARS frame for operational route workspaces. */
export function ConsoleWorkspace({
  ariaLabel,
  className,
  warnings,
  toolbar,
  children,
}: {
  ariaLabel: string;
  className: string;
  warnings?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`console-workspace ${className}`}
      aria-label={ariaLabel}
    >
      {warnings ? (
        <div className={`${className}__warnings`}>{warnings}</div>
      ) : null}
      {toolbar ? (
        <div className={`${className}__toolbar`}>{toolbar}</div>
      ) : null}
      {children}
    </section>
  );
}
