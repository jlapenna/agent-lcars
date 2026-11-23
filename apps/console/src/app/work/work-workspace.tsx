import { type ReactNode, Suspense } from 'react';

import { DataWarnings } from '../console-header';
import { ConsoleWorkspace } from '../console-workspace';

/**
 * Route-level composition for native work items.
 *
 * Like Shuttlebay, Work never adopted the shared frame: its content — a
 * create form and a six-column table — sat directly on the page ground with
 * no workspace edge and no responsive treatment, so a phone got a table
 * scrolled off the side of the viewport and a desktop got an unframed slab
 * (#1814). The frame supplies the edge and the bands; `work-workspace`'s own
 * rules below it supply the responsive column behavior.
 */
export function WorkWorkspace({
  ariaLabel = 'Work items',
  warnings,
  toolbar,
  children,
}: {
  /** `/work/schedules` reuses this frame for the same route accent and the
   *  same section rhythm, and names its own region. */
  ariaLabel?: string;
  /** The band's verdict on the route's Work API read (`WorkReadWarnings`). */
  warnings?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel={ariaLabel}
      className="work-workspace"
      warnings={warnings}
      toolbar={toolbar}
    >
      <div className="work-workspace__content">{children}</div>
    </ConsoleWorkspace>
  );
}

interface WorkReadError {
  code: string;
  message: string;
}

type WorkRead = { error: WorkReadError } | { stoppedOn?: WorkReadError };

/** The band's verdict on a Work API read: a failed or partial read is a
 * warning; no read (invalid filters) or a login without the Work grant says
 * nothing either way. */
export function workReadWarnings(read: WorkRead | undefined): {
  warnings: string[];
  sourcesChecked: boolean;
} {
  if (read === undefined) return { warnings: [], sourcesChecked: false };
  if ('error' in read) {
    return read.error.code === 'UNAUTHORIZED'
      ? { warnings: [], sourcesChecked: false }
      : {
          warnings: [`Work API unavailable: ${read.error.message}`],
          sourcesChecked: true,
        };
  }
  return {
    warnings: read.stoppedOn
      ? [`Work API stopped reading older work: ${read.stoppedOn.message}`]
      : [],
    sourcesChecked: true,
  };
}

async function WorkReadVerdict({
  read,
}: {
  read: () => Promise<WorkRead | undefined>;
}) {
  return <DataWarnings {...workReadWarnings(await read())} />;
}

/** The warnings band for a Work route, settled by the same request-cached
 * read its body renders; until then it claims nothing about the sources. */
export function WorkReadWarnings({
  read,
}: {
  read: () => Promise<WorkRead | undefined>;
}) {
  return (
    <Suspense fallback={<DataWarnings warnings={[]} sourcesChecked={false} />}>
      <WorkReadVerdict read={read} />
    </Suspense>
  );
}
