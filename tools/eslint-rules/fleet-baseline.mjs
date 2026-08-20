/**
 * Fleet ESLint baseline — the hygiene rules that are the same everywhere.
 *
 * This is local configuration. If the fleet needs shared lint behavior, it
 * must be supplied by a shared fleet artifact rather than copied source.
 *
 * Repo-neutral by construction: nothing here may name a repo's own package
 * scope, issue numbers, or paths. Anything repo-specific stays in that
 * repo's own root `eslint.config.mjs` — this file was extracted from two
 * configs that had independently drifted (one was missing the dynamic-import
 * ban and two of the three `toLocale*String` evasion shapes; the other ran
 * import/unused hygiene at `warn` instead of `error`), which is exactly the
 * failure mode a shared definition prevents.
 *
 * Usage, from each repo's root eslint.config.mjs:
 *
 *   import { fleetBaseline } from './tools/eslint-rules/fleet-baseline.mjs';
 *   export default [ ...someStuff, ...fleetBaseline({ simpleImportSort, unusedImports }), ...moreStuff ];
 *
 * The plugin objects are injected rather than imported here so this file
 * stays free of package-resolution assumptions (the two repos install the
 * same two plugins, but from their own lockfiles).
 */

/**
 * `no-restricted-syntax` entries every repo in the fleet enforces.
 *
 * The three `toLocale*String` selectors are one rule split across the three
 * shapes that reach the same bug: a bare call, an explicit `undefined`
 * locale, and an empty-array locale list all fall back to the runtime's
 * locale and timezone, which differ between the server that renders and the
 * browser that hydrates (React #418). Matching only the bare call — as one
 * repo did — leaves the other two shapes as silent evasions.
 */
export const FLEET_RESTRICTED_SYNTAX = Object.freeze([
  {
    selector: "CallExpression[callee.name='require']",
    message: 'Using require() is not allowed. Use ES static imports instead.',
  },
  {
    selector: 'ImportExpression',
    message: 'Dynamic import() is not allowed. Use ES static imports instead.',
  },
  {
    selector:
      'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.length=0]',
    message:
      "Bare toLocale*String() depends on the runtime locale/timezone and causes hydration mismatches (React #418). Pin them, e.g. toLocaleDateString('en-US', { timeZone: 'UTC' }).",
  },
  {
    selector:
      "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.type='Identifier'][arguments.0.name='undefined']",
    message:
      "toLocale*String(undefined, …) uses the runtime locale and causes hydration mismatches (React #418). Pin the locale, e.g. 'en-US', and include a timeZone.",
  },
  {
    selector:
      "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.type='ArrayExpression'][arguments.0.elements.length=0]",
    message:
      "toLocale*String([], …) uses the runtime locale and causes hydration mismatches (React #418). Pin the locale, e.g. 'en-US', and include a timeZone.",
  },
]);

/**
 * Options for `unused-imports/no-unused-vars`, per
 * https://typescript-eslint.io/rules/no-unused-vars/. `_`-prefixed names are
 * the fleet's one escape hatch.
 */
export const FLEET_UNUSED_VARS_OPTIONS = Object.freeze({
  args: 'all',
  argsIgnorePattern: '^_',
  caughtErrors: 'all',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  ignoreRestSiblings: true,
});

/** Every script file kind either repo compiles or ships. */
const SCRIPT_FILES = ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'];

/**
 * @param {object} plugins
 * @param {object} plugins.simpleImportSort `eslint-plugin-simple-import-sort`
 * @param {object} plugins.unusedImports `eslint-plugin-unused-imports`
 * @returns {object[]} flat-config entries to spread into a root config
 */
export function fleetBaseline({ simpleImportSort, unusedImports }) {
  if (!simpleImportSort || !unusedImports) {
    throw new Error(
      'fleetBaseline() needs both the simple-import-sort and unused-imports plugin objects.',
    );
  }
  return [
    {
      files: SCRIPT_FILES,
      plugins: {
        'simple-import-sort': simpleImportSort,
        'unused-imports': unusedImports,
      },
      rules: {
        // `error`, not `warn`, on every one of these: a warning in a
        // repo whose lint task does not pass --max-warnings=0 is a rule
        // that never fails anything, and the two repos disagreed on which
        // half was which.
        'simple-import-sort/imports': 'error',
        'simple-import-sort/exports': 'error',
        // Superseded by unused-imports/no-unused-vars below, which reports
        // the same violations with an auto-fix for the import case.
        '@typescript-eslint/no-unused-vars': 'off',
        'unused-imports/no-unused-imports': 'error',
        'unused-imports/no-unused-vars': ['error', FLEET_UNUSED_VARS_OPTIONS],
        'no-restricted-syntax': ['error', ...FLEET_RESTRICTED_SYNTAX],
      },
    },
    {
      // A .cjs file is CommonJS by extension: require() is its only import
      // mechanism and dynamic import() its only way to reach an ESM module,
      // so the syntax bans are unsatisfiable ceremony there. Import-order
      // and unused-symbol hygiene above still apply. Both repos already
      // exempted .cjs this way (one explicitly, one by never globbing it),
      // which keeps local CommonJS helpers free of eslint-disable comments.
      files: ['**/*.cjs'],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ];
}
