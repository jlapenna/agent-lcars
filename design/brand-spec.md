# Agent LCARS — console brand spec (dark scheme)

Source: `jlapenna/agent-lcars` → `apps/console/src/app/theme.ts`, `global.css`,
`fonts.ts`, `docs/console-design-system.md`. Values below are the repo's own
palette anchors and dark ramp, not guesses.

One sentence: one near-black ground, one bright LCARS accent per destination,
flat square controls, and a single concentric elbow that frames the page.

## Core tokens

| token       | hex (repo) | OKLch (approx)          | repo name                 |
| ----------- | ---------- | ----------------------- | ------------------------- |
| `--bg`      | `#060709`  | `oklch(0.12 0.004 265)` | `--lcars-surface` dark-9  |
| `--surface` | `#08090c`  | `oklch(0.13 0.005 265)` | `--lcars-surface-raised`  |
| `--fg`      | `#eeeff2`  | `oklch(0.95 0.004 270)` | `--lcars-ink` gray-0      |
| `--muted`   | `#a5adc0`  | `oklch(0.75 0.025 265)` | `--lcars-ink-dim` dark-2  |
| `--border`  | `#212736`  | `oklch(0.27 0.025 265)` | `--lcars-hairline` dark-6 |
| `--accent`  | `#ff9f45`  | `oklch(0.79 0.15 62)`   | `--lcars-amber` (Bridge)  |

Destination accents: amber `#ff9f45` (Bridge), blue `#6c8fe0` (Inbox,
Shuttlebay), periwinkle `#8c8fde` (Agents), violet `#b15fc7` (Work), teal
`#4fb8c4` (Sessions), gold `#e0b84b` (Costs). Ink on accent `#06070a`.

Status (never a route accent): success `#4fae8c`, warning `#b98e19`,
failure `#d9694f`. Focus ring is always amber.

## Type

- Display: `Antonio 500–700`, uppercase, tracked 0.04–0.06em — headings, eyebrows, rail labels only.
- Body: `IBM Plex Sans 400–600`.
- Mono: `IBM Plex Mono 400/500` — IDs, issue refs, figures.

## Rules observed

1. One ground. Regions separate by hairline, gutter or accent bar — never a second black.
2. Accent as block takes near-black ink; accent as text uses an 80% mix with white.
3. Primary = full accent block (one per page); secondary = 52% mix with white type.
4. Radius 0 everywhere; the header elbow (outer 32px / inner 16px) is the only curve.
5. Panels carry a 6px square spine; the signal bar is blue 0–56%, violet 56–76%, gold 76–100%.
