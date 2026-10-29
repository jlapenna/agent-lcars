package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type placementObservation struct {
	RunID            string `json:"runId"`
	Runner           string `json:"runner"`
	ClaimFingerprint string `json:"claimFingerprint"`
	JobUID           string `json:"jobUid"`
	ObservedAt       string `json:"observedAt"`
	Placed           bool   `json:"placed"`
}

func queueStartupPlacementReporter(consoleURL string, idToken func() (string, error)) func(context.Context, placementObservation) error {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	acquireToken := queueClaimTokenAcquisition(idToken)
	return func(ctx context.Context, observation placementObservation) error {
		token, err := acquireToken(ctx)
		if err != nil {
			return fmt.Errorf("placement identity unavailable")
		}
		body, err := json.Marshal(observation)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(consoleURL, "/")+"/api/work/v1/runs/"+url.PathEscape(observation.RunID)+"/startup-placement", bytes.NewReader(body))
		if err != nil {
			return fmt.Errorf("building placement request")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("placement request unavailable")
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("placement returned HTTP %d", resp.StatusCode)
		}
		response, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
		if err != nil || len(response) > 64<<10 {
			return fmt.Errorf("placement response unavailable")
		}
		var result struct {
			RunID     string `json:"runId"`
			JobUID    string `json:"jobUid"`
			ExpiresAt string `json:"expiresAt"`
		}
		if json.Unmarshal(response, &result) != nil || result.RunID != observation.RunID || result.JobUID != observation.JobUID {
			return fmt.Errorf("placement response identity conflict")
		}
		if _, err := time.Parse(time.RFC3339Nano, result.ExpiresAt); err != nil {
			return fmt.Errorf("placement deadline invalid")
		}
		return nil
	}
}

// Only an actual live UID-owned Pod is placement evidence. An absent Pod,
// suspended/modified Job, terminal attempt or API failure cannot renew waiting.
// Assignment starts bootstrap even if image pull or container startup stalls.
func (q *kubernetesQueue) observeJobStartupPlacement(ctx context.Context, job *batch.Job, pods *core.PodList) error {
	if q.reportStartupPlacement == nil {
		return nil
	}
	runID := job.Annotations[queueRunAnnotation]
	if job.UID == "" || job.Name != queueJobName(runID) || job.Labels[queueJobLabel] != "true" ||
		job.Annotations[queueRunnerAnnotation] == "" || job.Annotations[queueClaimAnnotation] == "" ||
		job.DeletionTimestamp != nil || queueJobTerminal(*job) || job.Spec.Suspend == nil || *job.Spec.Suspend || job.Generation != 2 {
		return nil
	}
	if pods == nil {
		var err error
		pods, err = q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{})
		if err != nil {
			return err
		}
	}
	var owned *core.Pod
	for i := range pods.Items {
		p := &pods.Items[i]
		if !podOwnedBy(*p, job) {
			continue
		}
		if owned != nil || p.UID == "" || p.DeletionTimestamp != nil ||
			(p.Status.Phase != core.PodPending && p.Status.Phase != core.PodRunning) {
			return nil
		}
		owned = p
	}
	if owned == nil {
		return nil
	}
	placed := owned.Spec.NodeName != ""
	if !placed {
		if owned.Status.Phase != core.PodPending || owned.Status.StartTime != nil {
			return nil
		}
		for _, status := range append(append([]core.ContainerStatus{}, owned.Status.InitContainerStatuses...), owned.Status.ContainerStatuses...) {
			if status.RestartCount != 0 || status.State.Running != nil || status.State.Terminated != nil || status.LastTerminationState.Terminated != nil {
				return nil
			}
		}
	}
	return q.reportStartupPlacement(ctx, placementObservation{RunID: runID, Runner: job.Annotations[queueRunnerAnnotation], ClaimFingerprint: job.Annotations[queueClaimAnnotation], JobUID: string(job.UID), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Placed: placed})
}

// podOwnedBy reports whether p is controlled by exactly Job j (name and UID).
func podOwnedBy(p core.Pod, j *batch.Job) bool {
	for _, o := range p.OwnerReferences {
		if o.Kind == "Job" && o.APIVersion == "batch/v1" && o.Name == j.Name && o.UID == j.UID && o.Controller != nil && *o.Controller {
			return true
		}
	}
	return false
}
