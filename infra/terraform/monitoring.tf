# Cloud Tasks throttles a queue on its own error rate. On 2026-09-15/16 one
# GitHub anchor's projection refresh returned 500 forever, dispatch-webhooks
# backed up to 710 tasks (349 retrying), and unrelated webhook deliveries
# starved for 40+ minutes before anyone noticed (agent-lcars#1985, #1988
# fixed the root cause). Nothing alerted. These resources add detection for
# both symptoms: a growing backlog and a rising failure rate.
#
# alert_email is supplied at `terraform apply` time
# (`-var alert_email=<address>` or `TF_VAR_alert_email`) and is never
# committed -- see infra/terraform/README.md.
resource "google_monitoring_notification_channel" "alert_email" {
  project      = var.project_id
  display_name = "Agent LCARS maintainer email"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "dispatch_webhooks_queue_backlog" {
  project      = var.project_id
  display_name = "Dispatch webhook queue backlog"
  combiner     = "OR"

  conditions {
    display_name = "dispatch-webhooks queue depth > 200 for 30m"
    condition_threshold {
      filter          = "metric.type=\"cloudtasks.googleapis.com/queue/depth\" AND resource.type=\"cloud_tasks_queue\" AND resource.label.queue_id=\"dispatch-webhooks\""
      comparison      = "COMPARISON_GT"
      threshold_value = 200
      duration        = "1800s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  conditions {
    # task_attempt_count is a DELTA INT64 metric with a `response_code`
    # label carrying the canonical response code as a string (e.g. "ok");
    # verified against the live metric descriptor in this project on
    # 2026-09-15 -- it has no `response_code_class` label, so the filter
    # below tests response_code directly rather than a class bucket.
    # ALIGN_RATE turns the per-interval delta into attempts/second, and
    # REDUCE_SUM with queue_id as the only group-by field folds every
    # non-"ok" response code into a single series so any mix of failure
    # codes (not just one) trips the threshold. GT 0.05/s is approximately
    # 15 failing attempts per 5-minute alignment window.
    display_name = "dispatch-webhooks non-ok task attempts > 0.05/s for 30m"
    condition_threshold {
      filter          = "metric.type=\"cloudtasks.googleapis.com/queue/task_attempt_count\" AND resource.type=\"cloud_tasks_queue\" AND resource.label.queue_id=\"dispatch-webhooks\" AND metric.label.response_code!=\"ok\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      duration        = "1800s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.queue_id"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.alert_email.name]

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      ## What this means

      The `dispatch-webhooks` Cloud Tasks queue (project `agent-lcars`,
      `us-central1`) is backed up, is failing a meaningful share of its task
      attempts, or both. On 2026-09-15/16 one GitHub anchor's projection
      refresh returned 500 forever; Cloud Tasks throttled the queue on error
      rate and unrelated webhook deliveries starved for 40+ minutes with no
      alert. agent-lcars#1985 and #1988 fixed that root cause; this policy
      adds the detection that was missing.

      ## First checks

      1. List in-flight tasks and see how many have actually been attempted:

         ```sh
         gcloud tasks list --queue dispatch-webhooks --location us-central1 \
           --project agent-lcars --limit 5000 \
           --format='value(name,dispatchCount)'
         ```

         Count how many rows have `dispatchCount > 0` -- a large share means
         the queue is retrying, not merely deep.

      2. Look for the failing handler in Cloud Logging:

         ```
         resource.type="cloud_run_revision" AND
         httpRequest.requestUrl:"/api/control-plane/webhook/process" AND
         httpRequest.status=500
         ```

         The `retaining projection-only webhook repair` log line now carries
         the cause of the failure directly.

      3. See the homelab oncall runbook: `jlapenna/homelab`
         `docs/incidents.md` ("Dispatch webhook queue starved by one
         poisoned anchor", 2026-09-16) and `.agents/skills/oncall/SKILL.md`
         §1 for this alert's entry.
    EOT
  }

  depends_on = [google_project_service.services]
}
