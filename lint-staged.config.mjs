export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': [
    'eslint --fix --max-warnings=0',
    'prettier --write',
  ],
  '*.{css,json,jsonc,md,yaml,yml}': 'prettier --write',
  '**/package.json': './tools/check-dependencies.sh',
};
