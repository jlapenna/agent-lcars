# LCARS console design prototypes

Browser-renderable design prototypes for the LCARS console. Open the HTML files
directly (they load bundled fonts from `assets/fonts/` with no build step).

**These are explorations, not the contract.** The canonical visual system is
[`../console-design-system.md`](../console-design-system.md) and the token
source of truth is `apps/console/src/theme.ts`. Where a prototype and the
design system disagree, the design system wins.

| Artifact                                              | Purpose                                              |
| ----------------------------------------------------- | ---------------------------------------------------- |
| [`fleet-console.html`](fleet-console.html)            | Full console dashboard / overview mockup             |
| [`agent-lcars-ui-kit.html`](agent-lcars-ui-kit.html)  | Component and pattern reference sheet                |
| [`brand-spec.md`](brand-spec.md)                      | Design brief: voice, palette direction, constraints  |
| `assets/fonts/`                                       | Subset webfonts used by the artifacts (see licenses) |

`*.html.artifact.json` sidecars are OpenDesign metadata and can be ignored by
readers.

## Provenance

Generated with OpenDesign from the brief in `brand-spec.md`. The in-repo
snapshot is the source of truth: prototypes are authored in an OpenDesign
workspace and promoted here through a normal PR — nothing in this folder is
edited out-of-band, and `main` plus CI gate every change.

## Font licenses

The subset fonts (Antonio, IBM Plex Sans/Mono) are redistributed from
[Google Fonts](https://fonts.google.com/) under the SIL Open Font License 1.1.
See [`assets/fonts/FONT-LICENSES.md`](assets/fonts/FONT-LICENSES.md).
