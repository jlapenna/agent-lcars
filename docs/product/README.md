# Agent LCARS product spec

This product specification comes in two parts:

1. [The console](console-product-spec.md): the maintainer-facing control
   surface. It covers information architecture, each destination, auth,
   live data, the visual system, the companion CLI, and the frontend roadmap.
2. [Fleet management and orchestration](fleet-orchestration-product-spec.md):
   intake, the task/run state machine, admission and queueing, execution, the
   worker contract, completion and merge, telemetry, fleet boundaries, and the
   control-plane roadmap.

Both parts describe the shipped product as of the commit named in their
headers, and mark each requirement as Shipped, Partial, or Proposed. They
summarize the system and do not replace its owners. Code, generated
contracts, and the canonical documents linked from each part remain
authoritative. When they disagree with a spec, correct the spec.
