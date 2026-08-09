import type { ProjectionStatus } from '@agent-lcars/dispatch-contracts';

import type { updateProjection } from './ledger-core';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type ProjectionPayload = Parameters<typeof updateProjection>[2];

// This production-typecheck contract fails if the projector capability is
// widened from exactly ProjectionStatus (for example to DispatchLedger, a
// callback, or a generic object capable of carrying controller-owned fields).
const projectionPayloadIsExact: Equal<ProjectionPayload, ProjectionStatus> =
  true;
void projectionPayloadIsExact;
