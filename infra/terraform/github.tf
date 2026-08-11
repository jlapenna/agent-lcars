# GitHub branch protection moved to the homelab repo's terraform root
# (homelab#523, maintainer decision 2026-08-11): one protect-main module
# there manages the harmonized "Protect main" ruleset for homelab,
# agent-lcars, AND supersprinklesracing/sprinkles, with scheduled drift
# checking. The live ruleset (id 19524095) was imported into homelab's
# state with a 0-diff plan, so this root hands it over WITHOUT
# destroying it. Change branch protection in
# homelab/terraform/github_rulesets.tf from now on — never here, never
# by hand (agent-lcars-dev/references/pr.md).
removed {
  from = github_repository_ruleset.protect_main

  lifecycle {
    destroy = false
  }
}
