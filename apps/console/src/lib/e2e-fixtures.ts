/**
 * Shared constants between the two e2e-only fixture routes (`api/e2e/seed`
 * and `api/e2e/github`) and the Playwright spec that asserts against them —
 * kept in one place so the branch name written by the seed route always
 * matches the branch the GitHub fixture route joins to a PR.
 */
export const E2E_FIXTURE_BRANCH = 'e2e-agent-lcars-fixture-branch';
