package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	core "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	podresource "k8s.io/component-helpers/resource"
)

// The console's Runners panel (design/fleet-console.html#shuttlebay) draws
// one row per runner pod: an ARC ephemeral runner or a queue executor Job
// pod. A fleet larger than this is not published at all rather than
// truncated, so the panel falls back to lane totals instead of a partial list.
const maxConsoleRunners = 128

const (
	runnerKindARC    = "arc"
	runnerKindDirect = "direct"

	runnerStarting = "starting"
	runnerIdle     = "idle"
	runnerBusy     = "busy"
	// An ARC runner that is up while its EphemeralRunner could not be read:
	// it may be idle or running a job, and the row does not guess.
	runnerOnline   = "online"
	runnerDraining = "draining"
	runnerOffline  = "offline"
)

// consoleRunner is one runner pod. Kind says where its job comes from: an
// ARC runner takes GitHub Actions jobs (JobRepository/JobName, once ARC's
// listener records the assignment), a direct runner runs the one LCARS run
// named by RunID.
type consoleRunner struct {
	Name                 string `firestore:"name"`
	Kind                 string `firestore:"kind"`
	Lane                 string `firestore:"lane"`
	Host                 string `firestore:"host,omitempty"`
	State                string `firestore:"state"`
	Since                string `firestore:"since"`
	RequestedCPUMillis   int64  `firestore:"requestedCpuMillis"`
	RequestedMemoryBytes int64  `firestore:"requestedMemoryBytes"`
	RunID                string `firestore:"runId,omitempty"`
	JobRepository        string `firestore:"jobRepository,omitempty"`
	JobName              string `firestore:"jobName,omitempty"`
	WorkflowRunID        int64  `firestore:"workflowRunId,omitempty"`
	// Unexported, so not published: matches an ARC pod to its EphemeralRunner.
	namespace string
}

// runnerFromPod classifies a runner pod, or reports false for any other pod.
// hosts is keyed by node name; a pod not yet scheduled has no host.
func runnerFromPod(pod *core.Pod, hosts map[string]*consoleHost) (consoleRunner, bool) {
	arc := pod.Labels[arcScaleSetLabel] != "" && pod.Labels[arcComponentKey] == arcRunnerValue
	direct := pod.Labels[queueJobLabel] == "true"
	if !arc && !direct {
		return consoleRunner{}, false
	}
	since := pod.CreationTimestamp.Time
	if pod.Status.StartTime != nil {
		since = pod.Status.StartTime.Time
	}
	requests := podresource.PodRequests(pod, podresource.PodResourcesOptions{})
	runner := consoleRunner{
		Name:                 pod.Name,
		namespace:            pod.Namespace,
		Host:                 pod.Spec.NodeName,
		Since:                since.UTC().Format(time.RFC3339),
		RequestedCPUMillis:   requests.Cpu().MilliValue(),
		RequestedMemoryBytes: requests.Memory().Value(),
	}
	if arc {
		runner.Kind, runner.Lane = runnerKindARC, pod.Labels[arcScaleSetLabel]
	} else {
		runner.Kind, runner.Lane = runnerKindDirect, runnerKindDirect
		runner.RunID = pod.Annotations[queueRunAnnotation]
	}
	host := hosts[pod.Spec.NodeName]
	switch {
	case host != nil && !host.Ready:
		runner.State = runnerOffline
	case pod.DeletionTimestamp != nil || host != nil && host.Unschedulable:
		runner.State = runnerDraining
	case pod.Status.Phase != core.PodRunning || !podReady(pod):
		runner.State = runnerStarting
	case direct:
		runner.State = runnerBusy
	default:
		runner.State = runnerOnline
	}
	return runner, true
}

func podReady(pod *core.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == core.PodReady {
			return c.Status == core.ConditionTrue
		}
	}
	return false
}

func sortRunners(runners []consoleRunner) {
	sort.Slice(runners, func(i, j int) bool {
		if runners[i].Host != runners[j].Host {
			return runners[i].Host < runners[j].Host
		}
		return runners[i].Name < runners[j].Name
	})
}

// arcRunnerJob is the job ARC's listener records on an EphemeralRunner when
// GitHub assigns it one.
type arcRunnerJob struct {
	repository, name string
	workflowRunID    int64
}

// arcRunnerJobs maps an EphemeralRunner's namespace/name, which its pod
// shares, to its job. A runner without an entry has none.
type arcRunnerJobs map[string]arcRunnerJob

type arcRunnerJobReader func(context.Context) (arcRunnerJobs, error)

const ephemeralRunnersPath = "/apis/actions.github.com/v1alpha1/ephemeralrunners"

// ephemeralRunnerJobs reads ARC's EphemeralRunners through the discovery REST
// client, as metricsServerUsage does, so no ARC clientset is needed.
func ephemeralRunnerJobs(client kubernetes.Interface) arcRunnerJobReader {
	rest := client.Discovery().RESTClient()
	if rest == nil {
		return nil
	}
	return func(ctx context.Context) (arcRunnerJobs, error) {
		raw, err := rest.Get().AbsPath(ephemeralRunnersPath).Do(ctx).Raw()
		if err != nil {
			return nil, err
		}
		return parseEphemeralRunners(raw)
	}
}

func parseEphemeralRunners(raw []byte) (arcRunnerJobs, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Status struct {
				JobRequestID      int64  `json:"jobRequestId"`
				JobRepositoryName string `json:"jobRepositoryName"`
				JobDisplayName    string `json:"jobDisplayName"`
				WorkflowRunID     int64  `json:"workflowRunId"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decoding ephemeral runners: %w", err)
	}
	jobs := arcRunnerJobs{}
	for _, item := range list.Items {
		status := item.Status
		if status.JobRequestID == 0 && status.JobRepositoryName == "" {
			continue
		}
		jobs[item.Metadata.Namespace+"/"+item.Metadata.Name] = arcRunnerJob{
			repository: status.JobRepositoryName, name: status.JobDisplayName, workflowRunID: status.WorkflowRunID,
		}
	}
	return jobs, nil
}

// applyRunnerJobs settles each up ARC runner as busy or idle and names the
// job of every ARC runner that has one.
func applyRunnerJobs(inventory *consoleHostInventory, jobs arcRunnerJobs) {
	for i := range inventory.Runners {
		runner := &inventory.Runners[i]
		if runner.Kind != runnerKindARC {
			continue
		}
		job, busy := jobs[runner.namespace+"/"+runner.Name]
		if busy {
			runner.JobRepository, runner.JobName, runner.WorkflowRunID = job.repository, job.name, job.workflowRunID
		}
		if runner.State != runnerOnline {
			continue
		}
		runner.State = runnerIdle
		if busy {
			runner.State = runnerBusy
		}
	}
	inventory.RunnerJobsKnown = true
}
