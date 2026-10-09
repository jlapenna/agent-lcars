package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	batch "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func queueClaimFingerprint(token string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(token)))
}

// This existing executor identity may inspect only its own exact claim. A
// run-token refusal, elapsed deadline or transport failure never authorizes
// deleting a Job. The route grants no new credential or mutation capability.
func queueClaimStatus(consoleURL string, idToken func() (string, error)) func(context.Context, string, string, string) (bool, error) {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	acquireToken := queueClaimTokenAcquisition(idToken)
	return func(ctx context.Context, runID, runner, fingerprint string) (bool, error) {
		token, err := acquireToken(ctx)
		if err != nil {
			return false, fmt.Errorf("queue claim status identity unavailable")
		}
		query := url.Values{"runner": {runner}, "claimFingerprint": {fingerprint}}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(consoleURL, "/")+"/api/work/v1/runs/"+url.PathEscape(runID)+"/claim-status?"+query.Encode(), nil)
		if err != nil {
			return false, fmt.Errorf("building queue claim status request")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(req)
		if err != nil {
			return false, fmt.Errorf("queue claim status request unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return false, fmt.Errorf("queue claim status returned HTTP %d", response.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
		if err != nil || len(body) > 64<<10 {
			return false, fmt.Errorf("queue claim status response unavailable")
		}
		var status struct {
			RunID            string `json:"runId"`
			Runner           string `json:"runner"`
			ClaimFingerprint string `json:"claimFingerprint"`
			Status           string `json:"status"`
		}
		if json.Unmarshal(body, &status) != nil || status.RunID != runID || status.Runner != runner || status.ClaimFingerprint != fingerprint || (status.Status != "live" && status.Status != "settled") {
			return false, fmt.Errorf("queue claim status identity conflict")
		}
		return status.Status == "settled", nil
	}
}

// OAuth's cached source cannot take a per-call context and may be waiting on
// another caller's refresh mutex. Cancel the sweep promptly while sharing
// one outstanding acquisition across subsequent sweeps. Its underlying real
// HTTP refresh is bounded in newDirectRunnerIDTokenSource; canceled callers
// neither accumulate goroutines nor wait for that refresh to finish.
func queueClaimTokenAcquisition(idToken func() (string, error)) func(context.Context) (string, error) {
	type acquisition struct {
		done  chan struct{}
		token string
		err   error
	}
	var mu sync.Mutex
	var pending *acquisition
	return func(ctx context.Context) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		mu.Lock()
		if pending == nil {
			pending = &acquisition{done: make(chan struct{})}
			current := pending
			go func() {
				current.token, current.err = idToken()
				mu.Lock()
				pending = nil
				close(current.done)
				mu.Unlock()
			}()
		}
		current := pending
		mu.Unlock()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-current.done:
			return current.token, current.err
		}
	}
}

// Cancel only the original handoff, after its exact claim has irreversibly
// settled. This includes unsuspended Pending Jobs; Pod phase is not evidence
// that execution never happened. Foreground GC and admission keep its Pods
// fenced until they disappear. Modified/re-suspended Jobs fail closed.
func (q *kubernetesQueue) retireSettledClaim(ctx context.Context, job *batch.Job) (bool, error) {
	runID, runner := job.Annotations[queueRunAnnotation], job.Annotations[queueRunnerAnnotation]
	if q.claimSettled == nil || job.DeletionTimestamp != nil || job.UID == "" || job.ResourceVersion == "" || runID == "" || runner == "" || job.Name != queueJobName(runID) || job.Labels[queueJobLabel] != "true" || job.Spec.Suspend == nil {
		return false, nil
	}
	if (*job.Spec.Suspend && (job.Generation != 1 || queueJobAttempted(job))) || (!*job.Spec.Suspend && job.Generation != 2) {
		return false, nil
	}
	fingerprint := job.Annotations[queueClaimAnnotation]
	if fingerprint == "" {
		// Previously-created Jobs can prove their claim using their immutable
		// owned Secret. A Secret-less legacy shell has no such proof.
		secret, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		owned := false
		for _, owner := range secret.OwnerReferences {
			if owner.Kind == "Job" && owner.APIVersion == "batch/v1" && owner.Name == job.Name && owner.UID == job.UID && owner.Controller != nil && *owner.Controller {
				owned = true
			}
		}
		if !owned || secret.Immutable == nil || !*secret.Immutable || len(secret.Data["run-token"]) == 0 {
			return false, fmt.Errorf("queue retirement credential identity conflict")
		}
		fingerprint = queueClaimFingerprint(string(secret.Data["run-token"]))
	}
	settled, err := q.claimSettled(ctx, runID, runner, fingerprint)
	if err != nil || !settled {
		return false, err
	}
	uid, rv := job.UID, job.ResourceVersion
	err = q.client.BatchV1().Jobs(q.config.Namespace).Delete(ctx, job.Name, meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &uid, ResourceVersion: &rv}, PropagationPolicy: ptr(meta.DeletePropagationForeground)})
	if err != nil && !apierrors.IsNotFound(err) {
		return false, err
	}
	q.logger.Info("Retired settled Kubernetes claim", "runId", runID, "job", job.Name)
	return true, nil
}
