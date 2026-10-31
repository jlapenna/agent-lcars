# LCARS console design prototypes

Browser-renderable design prototypes for the LCARS console. Open the HTML files
directly (they load bundled fonts from `assets/fonts/` with no build step).

`fleet-console.html` is the layout target for the console: its elbow rail,
header, workspace frame, panels and tables are what the routes are built to,
at three widths — desktop (64em and up), tablet (48–64em: compact elbow,
destination pills, readout strip) and phone (below 48em: destinations in the
⋯ menu, filters folded behind **Filters**, tables reflowed into rows). Its
numbers are sample data, and it shows only what the console renders: a readout
with no honest source is left out of both.

The prototype and the console must say the same thing. Change the design
first: a layout or behaviour change lands in the prototype in the same PR as
the console change (or before it), and a console change that departs from the
prototype updates it there too. A maintainer's decision about the console
outranks an older drawing — record it here rather than let the two disagree.
Decisions the prototype already carries:

- Jobs lists all registered jobs, including disabled and invalid sources, with
  search and state filters. One selected detail holds the overview, definition
  review and latest run; phones return to the list with All jobs. Repository
  installation is a separate explicit action and never implicitly enables jobs.
  Review is bound to the installed definition digest. Production uses the
  allowed-repository selector and existing refresh API; prototype source previews
  and simulated confirmations illustrate state changes, not additional APIs.
- Bridge includes recent event-driven triage and summaries, linking into Work.
  Work exposes an event-driven filter and source activity on detail pages; source
  revisions represent admitted work, not every raw webhook delivery.
- The Bridge has no repository select; its panels summarise the whole fleet.
- Every toolbar control applies on change; there is no Apply step.
- On phones the Inbox list and selected detail grow with their content; the
  document owns vertical scrolling. The Back bar stays available while reading
  a long detail. Desktop keeps independently scrolling list and detail panes.
- Inbox defaults to pending decisions. Completed reports open through their
  separate count button or the reason filter, with a return to decisions.
  Report permalinks remain readable without changing the list filter.
- The header carries **New work** (except on Work, whose toolbar owns it),
  Refresh, the ⋯ console menu (preferences and identity, plus the
  destinations below 64em, where the pills fold away) and the
  live status, which reads "Snapshot · loaded …" on routes without a stream.
- The data-warnings band says "All sources reporting" only when every read
  the page made completed.
- Panels the first drawing lacked are drawn in its language: Agents' fleet
  snapshot, CLI sessions and Claimed but idle; Shuttlebay's provider
  admission; Work's recent work; Sessions' by-issue groups; the Bridge's
  Stopped work, Waiting on deploy and Blocked; the Costs ledger (spend
  summary, breakdowns, deliverable attribution, by issue and by week).

The written rules are [`../docs/console-design-system.md`](../docs/console-design-system.md)
and the token source of truth is `apps/console/src/app/theme.ts`.

| Artifact                                             | Purpose                                              |
| ---------------------------------------------------- | ---------------------------------------------------- |
| [`fleet-console.html`](fleet-console.html)           | Full console dashboard / overview mockup             |
| [`agent-lcars-ui-kit.html`](agent-lcars-ui-kit.html) | Component and pattern reference sheet                |
| [`brand-spec.md`](brand-spec.md)                     | Design brief: voice, palette direction, constraints  |
| `assets/fonts/`                                      | Subset webfonts used by the artifacts (see licenses) |

`*.html.artifact.json` sidecars are OpenDesign metadata and can be ignored by
readers.

## Provenance

Generated with OpenDesign from the brief in `brand-spec.md`. The in-repo
snapshot is the source of truth: prototypes may be edited in an OpenDesign
workspace or directly, and either way reach this folder only through a normal
PR — nothing here is edited out-of-band, and `main` plus CI gate every change.
Before editing in OpenDesign, copy this folder into the workspace so it starts
from the current snapshot, not an older export.

## Font licenses

The subset fonts (Antonio, IBM Plex Sans/Mono) are redistributed from
[Google Fonts](https://fonts.google.com/) under the SIL Open Font License 1.1.
See [`assets/fonts/FONT-LICENSES.md`](assets/fonts/FONT-LICENSES.md).
