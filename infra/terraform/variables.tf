variable "project_id" {
  type    = string
  default = "agent-lcars"
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "billing_account" {
  type      = string
  sensitive = true
}
variable "github_owner" {
  type    = string
  default = "jlapenna"
}
variable "github_repository" {
  type    = string
  default = "agent-lcars"
}
# Full "owner/repo", not this repo's github_owner/github_repository pair -
# this is a different owner entirely. Kept as one variable (not split into
# owner/repo like the pair above) so a future rename only needs a single
# value updated, not a reconstructed interpolation - see agent-lcars#352,
# where a stale ${var.github_owner}/supersprinklesracing interpolation
# silently never matched this repo's real supersprinklesracing/sprinkles
# OIDC claim since before the repo's rename from "members" to "sprinkles".
variable "sprinkles_repository" {
  type    = string
  default = "supersprinklesracing/sprinkles"
}
variable "budget_notification_channels" {
  type    = list(string)
  default = []
}
