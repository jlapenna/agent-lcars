package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sort"
)

const queueReceiptAnnotation = "agent-lcars.capacity-receipt"
const queueJobUIDAnnotation = "agent-lcars.capacity-job-uid"
const queueBarrierAnnotation = "agent-lcars.capacity-barrier"

func capacityDefinitiveKubernetesError(err error) bool {
	// Transport failures, server timeouts and 5xx never prove a drained write.
	return apierrors.IsAlreadyExists(err) || apierrors.IsConflict(err) || apierrors.IsInvalid(err) || apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) || apierrors.IsNotFound(err) || apierrors.IsBadRequest(err)
}
func (q *kubernetesQueue) configureReceiptJob(job *batch.Job, l directRunnerLaunch) {
	b, _ := json.Marshal(l.receipt)
	job.Annotations[queueReceiptAnnotation] = string(b)
	job.Spec.TTLSecondsAfterFinished = nil
	job.Spec.Template.Annotations[queueReceiptAnnotation] = string(b)
	c := &job.Spec.Template.Spec.Containers[0]
	c.Env = append(c.Env, core.EnvVar{Name: "LCARS_CAPACITY_RECEIPT", Value: string(b)}, core.EnvVar{Name: "LCARS_CAPACITY_JOB_UID", ValueFrom: &core.EnvVarSource{FieldRef: &core.ObjectFieldSelector{FieldPath: "metadata.annotations['" + queueJobUIDAnnotation + "']"}}})
	mode := int32(0440)
	expiry := int64(3600)
	job.Spec.Template.Spec.Volumes = append(job.Spec.Template.Spec.Volumes, core.Volume{Name: "worker-identity", VolumeSource: core.VolumeSource{Projected: &core.ProjectedVolumeSource{DefaultMode: &mode, Sources: []core.VolumeProjection{{ServiceAccountToken: &core.ServiceAccountTokenProjection{Audience: q.config.Capacity.WorkerAudience, ExpirationSeconds: &expiry, Path: "token"}}}}}})
	c.VolumeMounts = append(c.VolumeMounts, core.VolumeMount{Name: "worker-identity", MountPath: "/run/agent-lcars-identity", ReadOnly: true})
}
func receiptJobMatches(job *batch.Job, r capacityReceipt) bool {
	if job == nil || job.UID == "" || job.ResourceVersion == "" || job.Name != r.JobName || job.Name != queueJobName(r.RunID) || job.Labels[queueJobLabel] != "true" || job.Annotations[queueRunAnnotation] != r.RunID || job.Annotations[queueRunnerAnnotation] != r.Runner {
		return false
	}
	var f capacityFence
	if json.Unmarshal([]byte(job.Annotations[queueReceiptAnnotation]), &f) != nil || f != r.capacityFence {
		return false
	}
	return r.JobUID == "" || string(job.UID) == r.JobUID
}
func receiptSecretMatches(s *core.Secret, j *batch.Job, r capacityReceipt) bool {
	if s == nil || s.UID == "" || s.Name != j.Name || s.DeletionTimestamp != nil || s.Immutable == nil || !*s.Immutable || len(s.Data["run-token"]) == 0 || (r.SecretUID != "" && string(s.UID) != r.SecretUID) {
		return false
	}
	for _, o := range s.OwnerReferences {
		if o.Kind == "Job" && o.APIVersion == "batch/v1" && o.Name == j.Name && o.UID == j.UID && o.Controller != nil && *o.Controller {
			return true
		}
	}
	return false
}
func podOwnedBy(p core.Pod, j *batch.Job) bool {
	for _, o := range p.OwnerReferences {
		if o.Kind == "Job" && o.APIVersion == "batch/v1" && o.Name == j.Name && o.UID == j.UID && o.Controller != nil && *o.Controller {
			return true
		}
	}
	return false
}
func (q *kubernetesQueue) bindReceipt(ctx context.Context, r capacityReceipt, n string, j *batch.Job, s *core.Secret, p *core.Pod) error {
	x := map[string]any{"action": "bind", "fence": r.capacityFence, "recoveryNonce": n, "jobUid": string(j.UID), "jobName": j.Name, "owned": true, "deleting": j.DeletionTimestamp != nil, "placed": p != nil && p.Spec.NodeName != "" && p.DeletionTimestamp == nil && p.Status.Phase != core.PodFailed && p.Status.Phase != core.PodSucceeded}
	if s != nil {
		hash := sha256.Sum256(s.Data["run-token"])
		x["secretUid"] = string(s.UID)
		x["secretTokenHash"] = hex.EncodeToString(hash[:])
	}
	if p != nil {
		x["podUid"] = string(p.UID)
	}
	_, err := q.capacity.command(ctx, x)
	return err
}
func (q *kubernetesQueue) launchReceipt(ctx context.Context, l directRunnerLaunch) error {
	q.receiptMu.Lock()
	defer q.receiptMu.Unlock()
	if l.receipt == nil || !l.receipt.valid(q.capacity.config.PoolID, l.runID) {
		return fmt.Errorf("receipt launch identity invalid")
	}
	r := capacityReceipt{capacityFence: *l.receipt, JobName: queueJobName(l.runID), Pipeline: l.pipeline, Runner: l.runner}
	n, err := q.capacity.recovery(ctx, r, "recover")
	if err != nil {
		return err
	}
	desired, err := q.job(l)
	if err != nil {
		return err
	}
	var job *batch.Job
	err = q.capacity.write(ctx, r, n, func() error {
		var e error
		job, e = q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, desired, meta.CreateOptions{})
		return e
	})
	if err != nil {
		// GET identifies the original accepted object, but cannot drain an unknown
		// Create. Its operation remains pending even when safe recovery continues.
		job, err = q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{})
		if err != nil {
			return fmt.Errorf("receipt Job create unresolved")
		}
	}
	if !receiptJobMatches(job, r) || job.DeletionTimestamp != nil || job.Annotations[queueBarrierAnnotation] != "" {
		return fmt.Errorf("receipt Job identity mismatch")
	}
	if err = q.bindReceipt(ctx, r, n, job, nil, nil); err != nil {
		return err
	}
	r.JobUID = string(job.UID)
	if job.Spec.Suspend == nil || !*job.Spec.Suspend || queueJobAttempted(job) || job.Generation != 1 {
		return fmt.Errorf("receipt launch cannot restart an attempted Job")
	}
	secret := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: job.Name, Namespace: q.config.Namespace, OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: job.Name, UID: job.UID, Controller: ptr(true)}}}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte(l.runToken)}}
	err = q.capacity.write(ctx, r, n, func() error {
		var e error
		secret, e = q.client.CoreV1().Secrets(q.config.Namespace).Create(ctx, secret, meta.CreateOptions{})
		return e
	})
	if err != nil {
		secret, err = q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
		if err != nil {
			return fmt.Errorf("receipt Secret create unresolved")
		}
	}
	if !receiptSecretMatches(secret, job, r) {
		return fmt.Errorf("receipt Secret identity mismatch")
	}
	if err = q.bindReceipt(ctx, r, n, job, secret, nil); err != nil {
		return err
	}
	r.SecretUID = string(secret.UID)
	return q.resumeReceipt(ctx, r, n, job, secret)
}
func (q *kubernetesQueue) resumeReceipt(ctx context.Context, r capacityReceipt, n string, original *batch.Job, s *core.Secret) error {
	current, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, original.Name, meta.GetOptions{})
	if err != nil {
		return err
	}
	if !receiptJobMatches(current, r) || current.UID != original.UID || current.DeletionTimestamp != nil || current.Annotations[queueBarrierAnnotation] != "" {
		return fmt.Errorf("receipt resume identity mismatch")
	}
	if current.Spec.Suspend == nil || !*current.Spec.Suspend || queueJobAttempted(current) || current.Generation != 1 {
		return nil
	}
	pods, err := q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{})
	if err != nil {
		return err
	}
	for _, p := range pods.Items {
		if podOwnedBy(p, current) {
			return fmt.Errorf("receipt resume has physical worker evidence")
		}
	}
	freshSecret, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, current.Name, meta.GetOptions{})
	if err != nil {
		return err
	}
	if !receiptSecretMatches(freshSecret, current, r) || freshSecret.UID != s.UID {
		return fmt.Errorf("receipt resume credential mismatch")
	}
	if err = q.bindReceipt(ctx, r, n, current, freshSecret, nil); err != nil {
		return err
	}
	// Update carries original UID/resourceVersion. A conflict is not permission
	// to adopt a retirement generation or replacement and retry its unsuspend.
	current.Spec.Template.Annotations[queueJobUIDAnnotation] = string(current.UID)
	current.Spec.Suspend = ptr(false)
	return q.capacity.write(ctx, r, n, func() error {
		_, e := q.client.BatchV1().Jobs(q.config.Namespace).Update(ctx, current, meta.UpdateOptions{})
		return e
	})
}
func (q *kubernetesQueue) reconcileReceipts(ctx context.Context) (err error) {
	q.capacity.pollMu.Lock()
	defer q.capacity.pollMu.Unlock()
	q.receiptMu.Lock()
	defer q.receiptMu.Unlock()
	defer func() { q.capacity.publishAvailability(err == nil) }()
	if err := q.capacity.ensureRegistered(ctx); err != nil {
		return err
	}
	inv, err := q.capacity.inventory(ctx)
	if err != nil {
		return err
	}
	jobs, pods, err := q.receiptPhysicalInventory(ctx, inv)
	if err != nil {
		return err
	}
	byName := map[string]*batch.Job{}
	for i := range jobs.Items {
		byName[jobs.Items[i].Name] = &jobs.Items[i]
	}
	q.capacity.mu.Lock()
	err = q.capacity.reconcileProducer(ctx, inv)
	q.capacity.mu.Unlock()
	if err != nil {
		return err
	}
	if err = q.capacity.ensureRegistered(ctx); err != nil {
		return err
	}
	// Close a drained operation incarnation before retiring one of its Jobs.
	// No claim/launch or recovery RPC can race this poll/receipt fence. Workers
	// keep their immutable activation permit and original exit claimant.
	if q.capacity.requestID == "" {
		for _, r := range inv.Receipts {
			j := byName[r.JobName]
			if j == nil {
				continue
			}
			ended, never := physicalReceiptWorkersEnded(j, pods.Items)
			if never {
				_, secretErr := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
				// Preserve a recoverable original Secret. Only a definitive
				// missing-Secret shell, or a terminal Job, enters rotation.
				if !apierrors.IsNotFound(secretErr) {
					continue
				}
			}
			if !ended {
				continue
			}
			mine := false
			for _, p := range r.Producers {
				if p.ProducerID == q.capacity.producerID && !p.Stopped {
					mine = true
				}
			}
			if !mine {
				continue
			}
			drained := true
			for _, receipt := range inv.Receipts {
				for _, p := range receipt.Producers {
					if p.ProducerID == q.capacity.producerID && len(p.PendingWrites) > 0 {
						drained = false
					}
				}
			}
			if !drained {
				continue
			}
			for _, p := range r.Producers {
				if p.ProducerID == q.capacity.producerID && !p.Stopped {
					q.capacity.mu.Lock()
					q.capacity.stopping = &capacityStopAttempt{ProducerID: p.ProducerID, Subject: p.Subject}
					q.capacity.mu.Unlock()
					if _, err := q.capacity.command(ctx, map[string]any{"action": "stop-producer", "fence": r.capacityFence, "producerId": p.ProducerID, "producerSubject": p.Subject, "fenced": false, "evidence": "serialized-controller-rpc-group-drained"}); err != nil {
						return err
					}
				}
			}
			q.capacity.mu.Lock()
			q.capacity.producerID = newCapacityIdentity()
			q.capacity.registered = false
			q.capacity.stopping = nil
			q.capacity.mu.Unlock()
			if err := q.capacity.ensureRegistered(ctx); err != nil {
				return err
			}
			inv, err = q.capacity.inventory(ctx)
			if err != nil {
				return err
			}
			break
		}
	}
	var errs []error
	for _, r := range inv.Receipts {
		if ctx.Err() != nil {
			return errors.Join(append(errs, ctx.Err())...)
		}
		n, e := q.capacity.recovery(ctx, r, "retire")
		if e != nil {
			errs = append(errs, e)
			continue
		}
		j := byName[r.JobName]
		if j == nil && r.JobUID == "" && r.Worker == nil && allCapacityProducersStopped(r) {
			if r.State != "retiring" {
				if _, e = q.capacity.command(ctx, map[string]any{"action": "retire", "fence": r.capacityFence, "recoveryNonce": n}); e != nil {
					errs = append(errs, e)
					continue
				}
				r.State = "retiring"
			}
			j, e = q.installAbsentBarrier(ctx, r)
			if e != nil {
				errs = append(errs, e)
				continue
			}
		}
		if j == nil || !receiptJobMatches(j, r) || j.DeletionTimestamp != nil {
			errs = append(errs, fmt.Errorf("receipt physical inventory unavailable"))
			continue
		}
		if r.State == "retiring" || allCapacityProducersStopped(r) {
			if e = q.retireReceipt(ctx, r, n, j, pods.Items); e != nil {
				errs = append(errs, e)
			}
			continue
		}
		s, e := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
		if e != nil || !receiptSecretMatches(s, j, r) {
			errs = append(errs, fmt.Errorf("receipt original credential unavailable"))
			continue
		}
		if e = q.bindReceipt(ctx, r, n, j, s, nil); e != nil {
			errs = append(errs, e)
			continue
		}
		if j.Spec.Suspend != nil && *j.Spec.Suspend && !queueJobAttempted(j) && j.Generation == 1 {
			_, e = q.capacity.command(ctx, map[string]any{"action": "authorize-producer", "fence": r.capacityFence, "recoveryNonce": n, "producerId": q.capacity.producerID})
			if e == nil {
				e = q.resumeReceipt(ctx, r, n, j, s)
			}
			if e != nil {
				errs = append(errs, e)
			}
			continue
		}
		candidates := []core.Pod{}
		for _, p := range pods.Items {
			if podOwnedBy(p, j) && p.UID != "" && p.DeletionTimestamp == nil && p.Status.Phase != core.PodFailed && p.Status.Phase != core.PodSucceeded {
				candidates = append(candidates, p)
			}
		}
		sort.Slice(candidates, func(a, b int) bool { return string(candidates[a].UID) < string(candidates[b].UID) })
		for _, p := range candidates {
			if r.Worker != nil && r.Worker.Active && r.Worker.PodUID != string(p.UID) {
				continue
			}
			if e = q.bindReceipt(ctx, r, n, j, s, &p); e != nil {
				errs = append(errs, e)
				break
			}
			generation := 1
			if r.Worker != nil {
				generation = r.Worker.Generation
				if !r.Worker.Active {
					generation++
				}
			}
			_, e = q.capacity.command(ctx, map[string]any{"action": "attest", "fence": r.capacityFence, "recoveryNonce": n, "jobUid": string(j.UID), "podUid": string(p.UID), "generation": generation, "owned": true})
			if e != nil {
				errs = append(errs, e)
			}
			break
		}
	}
	return errors.Join(errs...)
}
func (q *kubernetesQueue) installAbsentBarrier(ctx context.Context, r capacityReceipt) (*batch.Job, error) {
	// A missing object is never absence of a delayed accepted Create. Compete
	// atomically for the exact deterministic name with an inert credential-free
	// tombstone, then inspect whichever object actually won.
	j, err := q.job(directRunnerLaunch{runID: r.RunID, pipeline: r.Pipeline, runner: r.Runner, consoleURL: q.capacity.consoleURL, receipt: &r.capacityFence})
	if err != nil {
		return nil, err
	}
	j.Annotations[queueBarrierAnnotation] = r.Nonce
	j.Spec.Template.Spec.Containers[0].Command = []string{"/bin/false"}
	j.Spec.Template.Spec.Containers[0].Env = nil
	j.Spec.Template.Spec.Containers[0].VolumeMounts = nil
	j.Spec.Template.Spec.Volumes = nil
	created, err := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, j, meta.CreateOptions{})
	if err == nil {
		return created, nil
	}
	existing, e := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
	if e != nil {
		return nil, fmt.Errorf("absent-name retirement barrier unresolved")
	}
	return existing, nil
}
func (q *kubernetesQueue) verifyRetiredBarrier(ctx context.Context, j *batch.Job) error {
	var f capacityFence
	if json.Unmarshal([]byte(j.Annotations[queueReceiptAnnotation]), &f) != nil || !f.valid(q.capacity.config.PoolID, j.Annotations[queueRunAnnotation]) || j.Name != queueJobName(f.RunID) || j.UID == "" || j.ResourceVersion == "" || j.DeletionTimestamp != nil || j.Spec.Suspend == nil || !*j.Spec.Suspend || j.Spec.TTLSecondsAfterFinished != nil || j.Annotations[queueBarrierAnnotation] != f.Nonce {
		return fmt.Errorf("unrecognized queue Job inventory")
	}
	x, err := q.capacity.command(ctx, map[string]any{"action": "inspect-retired", "runId": f.RunID})
	if err != nil {
		return err
	}
	r := x.Retirement
	if r == nil || !r.Released || r.RunID != f.RunID || r.Nonce != f.Nonce || r.JobName != j.Name || r.Barrier == nil || r.Barrier.UID != string(j.UID) {
		return fmt.Errorf("unverified queue retirement barrier")
	}
	return nil
}

// Serialize complete observations with recovery. API success alone says
// nothing about readability or identity of the physical worker inventory.
func (q *kubernetesQueue) validateReceiptInventory(ctx context.Context) (err error) {
	q.receiptMu.Lock()
	defer q.receiptMu.Unlock()
	defer func() { q.capacity.publishAvailability(err == nil) }()
	inv, err := q.capacity.inventory(ctx)
	if err != nil {
		return err
	}
	_, _, err = q.receiptPhysicalInventory(ctx, inv)
	return err
}
func (q *kubernetesQueue) receiptPhysicalInventory(ctx context.Context, inv capacityInventory) (*batch.JobList, *core.PodList, error) {
	jobs, err := q.client.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		return nil, nil, err
	}
	pods, err := q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{})
	if err != nil {
		return nil, nil, err
	}
	byName := map[string]*batch.Job{}
	for i := range jobs.Items {
		j := &jobs.Items[i]
		byName[j.Name] = j
		found := false
		for _, r := range inv.Receipts {
			if receiptJobMatches(j, r) {
				found = true
				break
			}
		}
		if !found {
			if err = q.verifyRetiredBarrier(ctx, j); err != nil {
				return nil, nil, err
			}
		}
	}
	for _, r := range inv.Receipts {
		j := byName[r.JobName]
		if r.JobUID != "" && !receiptJobMatches(j, r) {
			return nil, nil, fmt.Errorf("receipt original Job inventory unavailable")
		}
		if r.Worker != nil && r.Worker.Active {
			found := false
			if j != nil && r.Worker.JobUID == string(j.UID) {
				for _, p := range pods.Items {
					if string(p.UID) == r.Worker.PodUID && podOwnedBy(p, j) {
						found = true
						break
					}
				}
			}
			if !found {
				return nil, nil, fmt.Errorf("receipt active worker inventory unavailable")
			}
		}
	}
	return jobs, pods, nil
}
func allCapacityProducersStopped(r capacityReceipt) bool {
	if len(r.Producers) == 0 {
		return false
	}
	for _, p := range r.Producers {
		if !p.Stopped {
			return false
		}
	}
	return true
}
func physicalReceiptWorkersEnded(j *batch.Job, pods []core.Pod) (bool, bool) {
	never := j.Generation == 1 && j.Spec.Suspend != nil && *j.Spec.Suspend && !queueJobAttempted(j)
	observed := 0
	for _, p := range pods {
		if !podOwnedBy(p, j) {
			continue
		}
		observed++
		never = false
		if p.DeletionTimestamp != nil || (p.Status.Phase != core.PodFailed && p.Status.Phase != core.PodSucceeded) || len(p.Status.ContainerStatuses) == 0 {
			return false, false
		}
		for _, s := range append(append([]core.ContainerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...) {
			if s.State.Terminated == nil {
				return false, false
			}
		}
	}
	return never || (queueJobTerminal(*j) && observed > 0), never
}
func (q *kubernetesQueue) retireReceipt(ctx context.Context, r capacityReceipt, n string, j *batch.Job, pods []core.Pod) error {
	if !allCapacityProducersStopped(r) {
		return fmt.Errorf("receipt producers not positively stopped")
	}
	ended, never := physicalReceiptWorkersEnded(j, pods)
	if !ended {
		return fmt.Errorf("receipt worker termination unproven")
	}
	if r.State != "retiring" {
		if _, err := q.capacity.command(ctx, map[string]any{"action": "retire", "fence": r.capacityFence, "recoveryNonce": n}); err != nil {
			return err
		}
	}
	if r.Worker != nil && r.Worker.Active {
		found := false
		for _, p := range pods {
			if podOwnedBy(p, j) && string(p.UID) == r.Worker.PodUID {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("receipt active worker retirement unproven")
		}
		if _, err := q.capacity.command(ctx, map[string]any{"action": "worker-retired", "fence": r.capacityFence, "recoveryNonce": n, "generation": r.Worker.Generation, "podUid": r.Worker.PodUID, "evidence": "owned-terminal-pod"}); err != nil {
			return err
		}
	}
	current, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
	if err != nil {
		return err
	}
	if !receiptJobMatches(current, r) || current.UID != j.UID || current.ResourceVersion != j.ResourceVersion || current.DeletionTimestamp != nil {
		return fmt.Errorf("receipt retirement CAS changed")
	}
	current.Spec.Suspend = ptr(true)
	current.Spec.TTLSecondsAfterFinished = nil
	current.Annotations[queueBarrierAnnotation] = r.Nonce
	barrier, err := q.client.BatchV1().Jobs(q.config.Namespace).Update(ctx, current, meta.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("receipt barrier write unresolved")
	}
	check, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
	if err != nil {
		return err
	}
	if check.UID != barrier.UID || check.ResourceVersion != barrier.ResourceVersion || check.Spec.Suspend == nil || !*check.Spec.Suspend || check.Annotations[queueBarrierAnnotation] != r.Nonce {
		return fmt.Errorf("receipt barrier readback mismatch")
	}
	release := map[string]any{"action": "release", "fence": r.capacityFence, "recoveryNonce": n, "barrierUid": string(check.UID), "barrierRunId": r.RunID, "barrierNonce": r.Nonce, "resourceVersion": check.ResourceVersion, "jobName": check.Name, "evidence": "uid-rv-inert-job-and-owned-pods", "inert": true, "physicalWorkersEnded": true, "neverStarted": never, "originalJobUid": r.JobUID}
	if r.JobUID == "" {
		delete(release, "originalJobUid")
	}
	_, err = q.capacity.command(ctx, release)
	return err // Preserve the name barrier even when release succeeds.
}
func (q *kubernetesQueue) quiesceReceipts(ctx context.Context) error {
	q.receiptMu.Lock()
	defer q.receiptMu.Unlock()
	inv, err := q.capacity.inventory(ctx)
	if err != nil {
		return err
	}
	for _, r := range inv.Receipts {
		for _, p := range r.Producers {
			if p.ProducerID == q.capacity.producerID && !p.Stopped {
				if len(p.PendingWrites) != 0 {
					return fmt.Errorf("receipt producer has ambiguous writes")
				}
				_, err = q.capacity.command(ctx, map[string]any{"action": "stop-producer", "fence": r.capacityFence, "producerId": p.ProducerID, "producerSubject": p.Subject, "fenced": false, "evidence": "controller-shutdown-rpc-group-drained"})
				return err
			}
		}
	}
	return nil
}
