// `--no-warn-ignored` rather than a path exclusion here: a staged file
// that eslint ignores by config still gets handed over by lint-staged, and
// an "ignored file" warning is fatal under --max-warnings=0. Suppressing
// the warning keeps the zero-tolerance budget meaningful for real findings
// and stays correct for any generated file rather than naming paths.
const ESLINT = 'eslint --fix --max-warnings=0 --no-warn-ignored';

export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': [ESLINT, 'prettier --write'],
  '*.{css,json,jsonc,md,yaml,yml}': 'prettier --write',
  '*.go': 'gofmt -w',
  '**/package.json': './tools/check-dependencies.sh',
};
