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
variable "budget_notification_channels" {
  type    = list(string)
  default = []
}
