import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { theme } from './theme';

// See page-shell-contract.test.ts for why this resolves its own directory
// with fileURLToPath rather than `new URL('.', import.meta.url)`.
const APP_DIRECTORY = dirname(fileURLToPath(import.meta.url));

function source(name: string): string {
  return readFileSync(join(APP_DIRECTORY, name), 'utf8');
}

/** Every component file under the app directory, tests excluded. */
function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
      ? [path]
      : [];
  });
}

const GLOBAL_CSS = source('global.css');

/** Declarations only, with comments stripped: the prose in this stylesheet
 * legitimately quotes the very patterns these rules forbid. */
const RULES = GLOBAL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The console's look is a system, not a set of per-route decisions, and it
 * has drifted back apart several times (#1812, #1815, #1820, #1825) because
 * nothing failed when a route restated a color, a surface, or a control in
 * its own terms. These assertions are that failure: each one names a rule of
 * the system and the drift it is there to stop.
 */
describe('LCARS design system contract', () => {
  describe('one ground', () => {
    it('resolves the scheme surfaces at Mantine’s own specificity', () => {
      // Mantine defines these variables on `:root[data-mantine-color-scheme]`
      // (0,2,0). The bare attribute selector this file used until #1825
      // scores (0,1,0) and lost every declaration silently, leaving the page
      // on dark-7 while the shells sat on dark-9.
      for (const scheme of ['dark', 'light']) {
        expect(RULES).toContain(`:root[data-mantine-color-scheme='${scheme}']`);
      }
      expect(RULES).not.toMatch(
        /^\[data-mantine-color-scheme='(dark|light)'\] \{/m,
      );
    });

    it('paints surfaces and ink from the tokens, never a raw ramp step', () => {
      // Every surface and every body ink in the file must come from a token.
      // A raw ramp step is how a second, near-identical black gets into the
      // app - the exact complaint that started this: "different header vs
      // body background colors". `color` counts too: a route that restates
      // its own ink is a route that will not follow the colour scheme.
      const rawRampSurfaces = [
        ...RULES.matchAll(/(?:background(?:-color)?|color):[^;]*;/g),
      ]
        .map((match) => match[0])
        .filter((declaration) =>
          /var\(--mantine-color-(dark-[6789]|gray-[01])\)/.test(declaration),
        );

      expect(rawRampSurfaces).toEqual([]);
    });

    it('anchors the light ground on the value Mantine will force anyway', () => {
      // MantineProvider injects a runtime <style> derived from `theme.white`
      // setting `--mantine-color-body` for the LIGHT scheme only, after every
      // static stylesheet - so this file cannot win that declaration no
      // matter what it says (#1836). Defining the light ground as the same
      // source means the two cannot disagree. Anchoring it on `gray-0`
      // instead left the page on #f4f4f6 and every panel on #eeeff2.
      const light = RULES.match(
        /:root\[data-mantine-color-scheme='light'\] \{([^}]*)\}/,
      );

      expect(light).not.toBeNull();
      expect(light?.[1]).toContain(
        '--lcars-surface: var(--mantine-color-white)',
      );
    });

    it('defines the surface tokens exactly once per scheme', () => {
      for (const token of [
        '--lcars-surface:',
        '--lcars-surface-raised:',
        '--lcars-hairline:',
        '--lcars-ink:',
      ]) {
        expect(RULES.split(token)).toHaveLength(3);
      }
    });
  });

  describe('flat controls', () => {
    it('gives no control a lit-from-above bevel or drop shadow', () => {
      // LCARS controls are areas of color, not raised objects. A shadow with
      // a vertical offset - `inset 0 -3px` on the nav pills, `inset 0 -2px`
      // on the header actions - is what read as the "3D aspect" the show
      // never had (#1826). A purely horizontal inset (an accent spine) and a
      // zero-offset ring (a signal halo) are not shadows and stay allowed.
      const verticalShadows = [...RULES.matchAll(/box-shadow:[^;]*;/g)]
        .map((match) => match[0].replace(/\s+/g, ' '))
        .filter((declaration) =>
          /(?:inset\s+)?-?[\d.]+px\s+-?(?!0(?:px)?\b)[\d.]+px/.test(
            declaration,
          ),
        );

      expect(verticalShadows).toEqual([]);
    });

    it('has no gradient standing in for a lit surface', () => {
      // The header elbow and the inbox signal bars are built from gradients
      // as flat color stops; a *radial* highlight or a soft vertical fade on
      // a control is the thing being excluded here.
      expect(RULES).not.toMatch(/linear-gradient\([^)]*rgba?\(/);
    });
  });

  describe('one accent per page', () => {
    it('declares each destination accent exactly once', () => {
      // Before #1825 the desktop and mobile header blocks each restated all
      // seven routes with `!important`, and had already drifted apart from
      // the rail's own table.
      // The table is the set of *bare* `[data-accent='x']` rules. Compound
      // selectors like `.lcars-header-bar-segment[data-accent='amber']` are
      // consumers of an accent, not declarations of one.
      const table = [
        ...RULES.matchAll(/(^|\n)\[data-accent='(\w+)'\] \{([^}]*)\}/g),
      ];
      const declarations = [...RULES.matchAll(/--lcars-accent:/g)];

      // The table, plus the single documented `:root` default that covers
      // anything rendered outside a route's page shell.
      expect(declarations).toHaveLength(table.length + 1);
      expect(RULES).toMatch(
        /:root \{[^}]*--lcars-accent: var\(--lcars-amber\);/,
      );
      for (const rule of table) {
        expect(rule[3]).toContain('--lcars-accent:');
      }
      expect(table.map((match) => match[2])).toEqual([
        'amber',
        'blue',
        'periwinkle',
        'violet',
        'teal',
        'gold',
      ]);
    });

    it('never hardcodes a route accent in a per-route selector', () => {
      expect(RULES).not.toMatch(/--lcars-header-accent/);
      expect(RULES).not.toMatch(/\.console-header\[data-current='\w+'\] \{/);
    });

    it('lets no [data-accent] rule restate a colour', () => {
      // The header's segment strip did exactly this - five accents spelled as
      // ramp steps - and had already fallen out of sync with the table by the
      // time anyone looked (#1829 moved the table onto the palette anchors;
      // the strip stayed behind). Anything keyed on `data-accent` gets its
      // colour from the token or not at all.
      const restated = [
        ...RULES.matchAll(/[^{}]*\[data-accent=[^{}]*\{[^}]*\}/g),
      ]
        .map((match) => match[0])
        .filter((rule) => /var\(--mantine-color-/.test(rule));

      expect(restated).toEqual([]);
    });

    it('defines the signal bar once and names its colours', () => {
      // Four hand-rolled copies with their own hues, stop percentages and
      // radii, none of which agreed.
      const definitions = [...RULES.matchAll(/--lcars-signal-stops:/g)];
      expect(definitions).toHaveLength(1);

      const gradients = [...RULES.matchAll(/linear-gradient\([^;]*;/g)]
        .map((match) => match[0])
        .filter((gradient) => /var\(--mantine-color-/.test(gradient));

      expect(gradients).toEqual([]);
    });

    it('keeps the signal bar a stop list, not a finished gradient', () => {
      // A `var()` inside a custom property is substituted on the element the
      // property is DECLARED on. A gradient baked into a `:root` token
      // therefore resolves any direction placeholder against `:root` and
      // permanently takes its fallback, so a use site cannot reorient it -
      // which silently rendered the Inbox's vertical rail horizontally
      // (Codex review on #1834). Keeping the token a bare stop list makes
      // that mistake unexpressible.
      const [declaration] = [
        ...RULES.matchAll(/--lcars-signal-stops:[^;]*;/g),
      ].map((match) => match[0]);

      expect(declaration).toBeDefined();
      expect(declaration).not.toContain('gradient');
      expect(declaration).not.toContain('to right');
      expect(declaration).not.toContain('to bottom');

      // ...and every consumer states its own orientation.
      const consumers = [
        ...RULES.matchAll(
          /linear-gradient\([^;]*var\(--lcars-signal-stops\)[^;]*;/g,
        ),
      ].map((match) => match[0]);

      expect(consumers.length).toBeGreaterThan(1);
      for (const consumer of consumers) {
        expect(consumer).toMatch(
          /linear-gradient\(\s*to (right|bottom|left|top)/,
        );
      }
    });
  });

  describe('square panels', () => {
    it('lets no panel override the theme\u2019s square default', () => {
      // `theme.ts` defaults Card and Paper to `radius: 0` - the curve on an
      // LCARS screen belongs to the elbow. A call site passing `radius="md"`
      // silently opts back out, which is how six panels kept rounded corners
      // inside the square frame after #1827 (#1836).
      const offenders: string[] = [];
      for (const file of componentFiles(APP_DIRECTORY)) {
        const contents = readFileSync(file, 'utf8');
        for (const match of contents.matchAll(/radius=\{?['"]?(\w+)/g)) {
          // Skeletons are loading placeholders, not panels.
          if (
            /Skeleton/.test(
              contents.slice(Math.max(0, match.index - 200), match.index),
            )
          ) {
            continue;
          }
          if (match[1] !== '0') {
            offenders.push(`${file.split('/app/')[1]}: radius=${match[1]}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe('one elbow per page', () => {
    it('draws the concentric elbow only in the page header', () => {
      // The elbow is the frame's device. `.lcars-panel::before` used to draw
      // a half-scale copy of it on every panel, so a route read as nested
      // chrome rather than one frame around a hierarchy of data (#1827).
      // Panels get a flat spine instead.
      const elbowRules = [...RULES.matchAll(/[^{}]*\{[^{}]*\}/g)]
        .map((match) => match[0])
        .filter((rule) => rule.includes('border-top-left-radius'));

      expect(elbowRules).not.toEqual([]);
      for (const rule of elbowRules) {
        // `.lcars-header::before` is the same elbow at the base breakpoint;
        // the desktop and mobile blocks replace it with the tapered build.
        expect(rule).toMatch(
          /\.lcars-header::before|\.console-header\[data-current\]::before/,
        );
      }
    });

    it('draws every leading-edge accent bar as the one shared spine', () => {
      // Matched by SHAPE, not by colour: a route that adds its own bar in its
      // own hardcoded hue would otherwise not look like a spine to this test
      // at all. That is exactly how the work route arrived with a 4px
      // off-palette `cyan` bar beside Sessions' 4px teal one and the shared
      // 6px accent one (#1823).
      const bars = [...RULES.matchAll(/[^{}]*::before \{[^}]*\}/g)]
        .map((match) => match[0])
        .filter(
          (rule) =>
            /left:\s*0/.test(rule) &&
            /\bwidth:/.test(rule) &&
            // The elbow is built from borders, not a width; it is the one
            // accent shape that is deliberately not a spine.
            !rule.includes('border-top-left-radius'),
        );

      expect(bars).not.toEqual([]);
      for (const bar of bars) {
        expect(bar).toContain('var(--lcars-spine-width)');
        expect(bar).toContain('var(--lcars-accent)');
      }
    });
  });

  describe('palette discipline', () => {
    it('uses only color families the theme actually defines', () => {
      // theme.ts overrides Mantine's slots in place and defines no cyan or
      // indigo, so `var(--mantine-color-cyan-5)` silently resolved to stock
      // Mantine hues sitting outside the LCARS palette - which is how the
      // Sessions header ended up a different teal from the Sessions rail
      // pill (#1815).
      const defined = new Set([...Object.keys(theme.colors ?? {}), 'white']);
      const used = new Set(
        [...GLOBAL_CSS.matchAll(/--mantine-color-([a-z]+)-\d/g)].map(
          (match) => match[1],
        ),
      );

      expect([...used].filter((family) => !defined.has(family))).toEqual([]);
    });
  });

  describe('one frame', () => {
    it('puts every primary destination in the shared workspace', () => {
      // Shuttlebay and Work rendered straight onto the page ground with no
      // frame, no warning band and no toolbar while their neighbours had all
      // three (#1814, #1828).
      for (const workspace of [
        'agents/agents-workspace.tsx',
        'sessions/sessions-workspace.tsx',
        'costs/costs-workspace.tsx',
        'shuttlebay/shuttlebay-workspace.tsx',
        'work/work-workspace.tsx',
      ]) {
        expect(source(workspace)).toContain('<ConsoleWorkspace');
      }
    });

    it('puts the message states in the frame too', () => {
      // Loading, not found and the error boundary rendered bare text on the
      // page ground under an otherwise complete LCARS header (#1833). They
      // are not workspaces, but they obey the same rule: content lives inside
      // the frame.
      for (const view of ['loading.tsx', 'not-found.tsx', 'error.tsx']) {
        expect(source(view)).toContain('<ConsoleMessage');
      }
      expect(source('console-message.tsx')).toContain('<ConsoleWorkspace');
    });

    it('leaves no route rendering its content outside a frame', () => {
      // Every `withConsolePageShell` view either composes a workspace itself
      // or delegates to one. `/work/schedules` was the last that did neither.
      for (const view of [
        'work/page.tsx',
        'work/schedules/page.tsx',
        'shuttlebay/page.tsx',
      ]) {
        expect(source(view)).toMatch(/<(Work|Shuttlebay)Workspace/);
      }
    });

    it('owns the warning and toolbar bands in one place', () => {
      expect(RULES).toContain('.console-workspace__warnings {');
      expect(RULES).toContain('.console-workspace__toolbar {');
      // Route-specific copies are what drifted; the shared class carries the
      // appearance and a route class may only arrange what is inside it.
      for (const band of ['warnings', 'toolbar']) {
        const routeCopies = [
          ...RULES.matchAll(
            new RegExp(`\\.([\\w-]+)-workspace__${band} \\{([^}]*)\\}`, 'g'),
          ),
        ].filter(
          (match) => match[1] !== 'console' && /background/.test(match[2]),
        );

        expect(routeCopies.map((match) => match[1])).toEqual([]);
      }
    });
  });
});
