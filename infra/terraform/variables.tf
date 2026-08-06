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
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+$", var.github_owner))
    error_message = "github_owner must be one exact GitHub owner without wildcards."
  }
}
variable "github_repository" {
  type    = string
  default = "agent-lcars"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be one exact GitHub repository without wildcards."
  }
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
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.sprinkles_repository))
    error_message = "sprinkles_repository must be one exact owner/repository pair without wildcards."
  }
}
variable "homelab_repository" {
  type    = string
  default = "jlapenna/homelab"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.homelab_repository))
    error_message = "homelab_repository must be one exact owner/repository pair without wildcards."
  }
}
variable "budget_notification_channels" {
  type    = list(string)
  default = []
}
