// `--no-warn-ignored` rather than a path exclusion here. The dispatch
// broker's committed bundle (.github/actions/dispatch-broker/dist) is
// generated output: eslint and prettier both ignore it by config, but
// lint-staged still hands it over because it is a staged .mjs file, and an
// "ignored file" warning is fatal under --max-warnings=0. Suppressing the
// warning keeps the zero-tolerance budget meaningful for real findings
// instead of trading it away, and it stays correct for any future generated
// file rather than naming this one path.
const ESLINT = 'eslint --fix --max-warnings=0 --no-warn-ignored';

export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': [ESLINT, 'prettier --write'],
  '*.{css,json,jsonc,md,yaml,yml}': 'prettier --write',
  '*.go': 'gofmt -w',
  '**/package.json': './tools/check-dependencies.sh',
};
