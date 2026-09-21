# This retired root relinquished the live Protect main ruleset (id 19524095)
# without destroying it when fleet governance moved to Homelab in 2026-08.
# The declaration returned to ../github-ruleset/ on 2026-09-21, with its own
# isolated state prefix and Homelab retaining trusted execution and scheduled
# drift checking. Keep this removed block as the history of the original state
# address; never manage the ruleset from this root or by hand
# (agent-lcars-dev/references/pr.md).
removed {
  from = github_repository_ruleset.protect_main

  lifecycle {
    destroy = false
  }
}
