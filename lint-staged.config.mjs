// Format staged files here. Linting runs through Nx in pre-push and required
// CI, where Nx owns graph preparation and task execution.

export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': 'prettier --write',
  '*.{css,json,jsonc,md,yaml,yml}': 'prettier --write',
  '*.go': 'gofmt -w',
  '**/package.json': './tools/check-dependencies.sh',
  // Rejects a bare `return` after `||` under `set -e` (jlapenna/homelab#1074,
  // jlapenna/homelab#1087): it returns the failed test's own exit status,
  // silently killing the function -- and its caller. tools/check-shell-bare-
  // return.sh accepts explicit file args, so lint-staged's staged-file list
  // passes straight through.
  '{tools,.github,apps}/**/*.sh': './tools/check-shell-bare-return.sh',
};
