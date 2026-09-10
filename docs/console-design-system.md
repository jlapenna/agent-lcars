# Console design system

The console's look is a system, not a set of per-route decisions. It has come
apart several times — #1812, #1815, #1820, #1822, #1825 — always the same way:
a change fixes one route in that route's own terms, the next change fixes the
next route in _its_ own terms, and after a few rounds the header and the body
are painted different blacks and every destination has its own button.

Read this before changing `apps/console/src/app/global.css` or any route
shell. `apps/console/src/app/design-system-contract.test.ts` enforces most of
it, and each assertion there names the drift it exists to stop.

## The five rules

### 1. One ground

The whole console paints `--lcars-surface` and nothing else — header, page,
workspace, `<Card>`, panel. Separation between regions comes from a hairline,
a gutter, or an accent bar. **Never from a second, slightly different black.**

| token                             | use                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `--lcars-surface`                 | the data plane; the one ground                                                      |
| `--lcars-surface-raised`          | genuinely floating chrome only: menus, popovers, sticky action bars, zebra striping |
| `--lcars-hairline`                | structural rules between regions                                                    |
| `--lcars-ink` / `--lcars-ink-dim` | text on the surface                                                                 |
| `--lcars-ink-on-accent`           | text on a full-strength accent block (near-black, both schemes)                     |
| `--lcars-ink-on-muted`            | text on a 52% accent block (scheme-aware)                                           |

A rule that reaches for `var(--mantine-color-dark-9)` directly is a rule that
will not follow the color scheme and will drift the next time the ramp moves.

The scheme tokens must be declared at `:root[data-mantine-color-scheme='…']`,
matching Mantine's own specificity (0,2,0). A bare `[data-…]` selector scores
(0,1,0), loses to Mantine, and does nothing — silently. That was #1825.

Never use `light-dark()` here. Lightning CSS downlevels it into a form this
build never completes, and the property computes to two space-separated colors
— invalid, and invalid without an error.

### 2. One accent, and one signal bar

`ConsolePageShell` stamps the route's `data-accent`; one table in `global.css`
turns that into an inherited `--lcars-accent` that the header elbow, the active
rail pill, panel spines, and the route's buttons all read.

There is **one declaration site per destination**, not one per component per
route per breakpoint. Keep the table in sync with `CONSOLE_DESTINATIONS` in
`console-navigation.ts`.

The values are `theme.ts`'s own documented palette anchors. They are the light
end of each ramp, which is what lets near-black type sit on a full-strength
block and clear WCAG AA (5.1:1–10.7:1). Moving an accent onto a darker ramp
step breaks that — near-black on `violet-5` measures 2.4:1.

`theme.ts` overrides Mantine's color slots in place and defines no `cyan` or
`indigo`. Using one resolves to a stock Mantine hue outside the LCARS palette.

The six accents are also named individually (`--lcars-amber` …
`--lcars-gold`) for the few places that need a _specific_ colour rather than
the route's. Nothing outside that block may name a ramp step for an accent —
including a rule keyed on `[data-accent]`, which is how the header's segment
strip ended up five ramp steps behind the table it exists to preview.

Keep status colour separate from route accent. `--lcars-warning` means
"something is wrong here" on every destination and deliberately does **not**
follow `--lcars-accent`; so does the focus ring, because an indicator that
changes colour per destination is harder to find. A rule reaching for a raw
`yellow-6` cannot say which of the two it meant.

The **signal bar** — the run of unequal colour segments used as the console's
decorative readout — is one token, `--lcars-signal-stops`. It is a bare stop
list, not a finished gradient, and that is load-bearing:

> A `var()` inside a custom property is substituted on the element the
> property is **declared** on, not on the element that finally uses it.

So baking `linear-gradient(var(--lcars-signal-direction, to right), …)` into a
`:root` token resolves the direction against `:root`, where it is never set,
and permanently takes the fallback — a use site setting `to bottom` has no
effect, silently. That shipped once (#1834) and rendered the Inbox's tall 6px
rail as three segments across its width. Orientation belongs at the use site,
spelled out.

### 3. Flat controls

LCARS controls are flat areas of color. They are not lit objects: **no bevel,
no inner highlight, no gradient, no drop shadow.** A shadow with a vertical
offset is the tell.

Two strengths, both taking `--lcars-accent`:

- **primary** — full-strength accent block, near-black type. One per context:
  the thing the page is for.
- **secondary** — the same block at 52%, scheme-aware type. Everything else,
  including anything that repeats once per list row.

52% is the strongest mix where the type on it still clears AA against both
grounds for every accent in the table.

A momentary `:active` transform is _not_ a bevel — it exists only while the
pointer is down, so it reads as the control answering rather than as a raised
object catching light. Feedback is fine; standing depth is not.

Scope control rules by **position**, not by component class. The header's
utility slot is fed by different components on different routes; a rule keyed
on where a control is cannot be missed by the next component that lands there.

### 4. One elbow

The elbow — a broad rail turning through a concentric quarter-circle into a
thinner arm — is the page frame's device. It appears **once per page**, in the
header, enclosing everything else.

Inside the frame, a panel gets a **spine**: a flat, square-ended bar of the
route accent down its leading edge, at `--lcars-spine-width`. Blocks inside the
frame are bars; the curve belongs to the structure that encloses them.

For the same reason `Card` and `Paper` default to `radius: 0`. A rounded card
inside a square workspace frame carrying a square spine is three corner
treatments on one block.

### 5. One frame

Every primary destination puts its content in `ConsoleWorkspace`. The frame
owns the ground, the edge, the warning band and the toolbar band; a route
decides only how information is arranged inside it.

Route-specific rules may not restate the frame's appearance. When three routes
each carried their own copy of the warning band, they drifted.

This covers more than the seven destinations. Sub-routes use the same frame as
their parent (`/work/schedules` reuses `WorkWorkspace`), and the message
states — loading, not found, the error boundary — use `ConsoleMessage`, which
is the same frame with a panel spine. Anything rendering its content as bare
text on the page ground is a bug, not a simpler case: it reads as an unstyled
fragment under an otherwise complete LCARS header.

A route that admits non-admins must not offer admin-only controls. `/work` and
`/work/schedules` are the only such routes; both pass the session's admin
status to `ConsoleCommandUtilities` as `includeQuickTask`, because Quick
task's submission paths (`createQuickTask` → `requireAdmin()`, and
`/api/quick-task/v1`) reject a `work.operator` who would otherwise use the
page fine.

## Shared header and body layout

`ConsoleAppShell` owns the transition from header to content. The body has a
16px inset on every route, including detail and message states. Do not cancel
it with negative margins or route-specific header offsets.

At 768px and above the header has two rows: title and global actions first,
then the destination rail. The frame reserves clearance below the elbow arm
and grows with the rail if navigation wraps. Never restore a fixed desktop
height or place navigation beside the title: long session titles and refresh
metadata must not squeeze each other out of the frame.

Below 768px the title and compact actions share one row; navigation is in the
utility menu. Routes without utilities keep their active destination link.
Utility variants use `console-utilities--desktop` and
`console-utilities--mobile`; their visibility and horizontal alignment belong
to the shared slot, never a list of route names. Tablet widths use compact
utilities while retaining the full rail. Local item actions stay in the body
or the existing overflow menu.

The required E2E lane consumes `mobile-header-every-page.spec.ts`, which checks
actual control bounds, elbow clearance, body inset, and document overflow
across destinations and detail views at phone, tablet, and desktop widths.

## Verifying a change

`test`, `lint` and `typecheck` cover the contract test and the component
behavior. For anything visual, the useful loop is the saved production session
(see the `verifying-console-session` skill): render the real routes with a
local `global.css` swapped in for the deployed CSS chunk, at 320/390/768/1024/
1280px in both color schemes. The 1024px case matters — the header overflowed
it on production for months (#1830) because the e2e suite checked 320/390/768
and then jumped to the 1280px default.
