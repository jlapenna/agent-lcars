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

### 2. One accent

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

## Verifying a change

`test`, `lint` and `typecheck` cover the contract test and the component
behavior. For anything visual, the useful loop is the saved production session
(see the `verifying-console-session` skill): render the real routes with a
local `global.css` swapped in for the deployed CSS chunk, at 320/390/768/1024/
1280px in both color schemes. The 1024px case matters — the header overflowed
it on production for months (#1830) because the e2e suite checked 320/390/768
and then jumped to the 1280px default.
