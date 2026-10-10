package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type queuePlacement struct {
	Phase        string `json:"phase"`
	Reason       string `json:"reason"`
	ObservedAt   string `json:"observedAt"`
	JobCreatedAt string `json:"jobCreatedAt,omitempty"`
}

// Job counters/Pod Running do not prove provider execution. Only the worker's
// existing providerProcessStarted heartbeat can establish that milestone.
func placementForJob(job batch.Job, pods []core.Pod, inventoryError error, now time.Time) queuePlacement {
	p := queuePlacement{Phase: "waiting-for-placement", Reason: "pending", ObservedAt: now.UTC().Format(time.RFC3339Nano)}
	if !job.CreationTimestamp.IsZero() {
		p.JobCreatedAt = job.CreationTimestamp.UTC().Format(time.RFC3339Nano)
	}
	if inventoryError != nil {
		p.Phase, p.Reason = "unavailable", "inventory-unavailable"
		return p
	}
	for _, pod := range pods {
		if pod.DeletionTimestamp != nil || pod.Status.Phase == core.PodSucceeded || pod.Status.Phase == core.PodFailed {
			continue
		}
		owned := false
		for _, owner := range pod.OwnerReferences {
			if owner.Kind == "Job" && owner.UID == job.UID && owner.Controller != nil && *owner.Controller {
				owned = true
			}
		}
		if !owned {
			continue
		}
		if pod.Spec.NodeName != "" {
			p.Phase, p.Reason = "bootstrapping", "scheduled"
			return p
		}
		for _, c := range pod.Status.Conditions {
			if c.Type == core.PodScheduled && c.Status == core.ConditionFalse && c.Reason == "Unschedulable" {
				p.Reason = "unschedulable"
			}
		}
	}
	return p
}

// Reporting is read-only to Kubernetes and isolated from admission/recovery.
// One bounded sweep publishes only live, fully identified Job claims; failure
// to list Jobs leaves previous observations to age out, never plausible zeros.
func (q *kubernetesQueue) observePlacements(ctx context.Context, report func(context.Context, batch.Job, queuePlacement) error) error {
	jobs, err := q.client.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		return fmt.Errorf("placement Job inventory unavailable")
	}
	pods, podErr := q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{})
	var items []core.Pod
	if podErr == nil {
		items = pods.Items
	}
	for _, job := range q.placementCursor.ordered(jobs.Items) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		q.placementCursor.visit(job.Name)
		runID := job.Annotations[queueRunAnnotation]
		if queueJobTerminal(job) || job.DeletionTimestamp != nil || job.UID == "" || runID == "" || job.Name != queueJobName(runID) || job.Annotations[queueClaimAnnotation] == "" || job.Annotations[queueRunnerAnnotation] == "" {
			continue
		}
		if err := report(ctx, job, placementForJob(job, items, podErr, time.Now())); err != nil {
			q.logger.Warn("Placement observation unavailable")
		}
	}
	return nil
}

func queuePlacementReporter(consoleURL string, idToken func() (string, error)) func(context.Context, batch.Job, queuePlacement) error {
	acquire := queueClaimTokenAcquisition(idToken)
	client := &http.Client{Timeout: consoleStatusTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, job batch.Job, placement queuePlacement) error {
		token, err := acquire(ctx)
		if err != nil {
			return fmt.Errorf("placement identity unavailable")
		}
		runID := job.Annotations[queueRunAnnotation]
		body, err := json.Marshal(struct {
			Runner           string         `json:"runner"`
			ClaimFingerprint string         `json:"claimFingerprint"`
			Placement        queuePlacement `json:"placement"`
		}{job.Annotations[queueRunnerAnnotation], job.Annotations[queueClaimAnnotation], placement})
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(consoleURL, "/")+"/api/work/v1/runs/"+url.PathEscape(runID)+"/placement", bytes.NewReader(body))
		if err != nil {
			return fmt.Errorf("placement request unavailable")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		response, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("placement transport unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("placement HTTP %d", response.StatusCode)
		}
		return nil
	}
}

func (q *kubernetesQueue) runPlacementObserver(ctx context.Context, report func(context.Context, batch.Job, queuePlacement) error) {
	tick := time.NewTicker(consoleStatusInterval)
	defer tick.Stop()
	for {
		sweep, cancel := context.WithTimeout(ctx, consoleStatusTimeout)
		if err := q.observePlacements(sweep, report); err != nil {
			q.logger.Warn("Placement inventory unavailable")
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
