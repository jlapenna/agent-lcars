package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"time"

	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	podresource "k8s.io/component-helpers/resource"
)

// ARC stamps this label on every pod of a runner scale set; its runner pods
// add app.kubernetes.io/component=runner (the listener's is
// runner-scale-set-listener).
const (
	arcScaleSetLabel = "actions.github.com/scale-set-name"
	arcComponentKey  = "app.kubernetes.io/component"
	arcRunnerValue   = "runner"
	// The console draws at most this many hosts; a larger cluster is
	// unexpected and is not published at all rather than truncated.
	maxConsoleHosts = 64
)

// consoleHostStatus is the cluster's host inventory: one row per node, with
// its allocatable CPU and memory, what the pods on it request (the
// scheduler's own accounting), its live usage when metrics-server reports
// it, and how many runner pods it carries. Listing nodes and pods is the
// queue executor's existing RBAC; live usage additionally needs list on
// metrics.k8s.io nodes, and without it the hosts publish requests alone.
type consoleHostStatus struct {
	SchemaVersion int    `firestore:"schemaVersion"`
	Kind          string `firestore:"kind"`
	// A pointer keeps the document comparable; see consoleStatusDocument.
	Inventory *consoleHostInventory `firestore:"inventory"`
	UpdatedAt string                `firestore:"updatedAt"`
	ExpireAt  time.Time             `firestore:"expireAt"`
}

type consoleHostInventory struct {
	Hosts []consoleHost `firestore:"hosts"`
	// Every runner pod; see consoleRunner. Nil when the fleet has more than
	// maxConsoleRunners, and then not published.
	Runners []consoleRunner `firestore:"runners"`
	// False when ARC's EphemeralRunners could not be read: up ARC runners
	// are then online, neither idle nor busy, and name no job.
	RunnerJobsKnown bool `firestore:"runnerJobsKnown"`
}

type consoleHost struct {
	Name          string `firestore:"name"`
	Ready         bool   `firestore:"ready"`
	Unschedulable bool   `firestore:"unschedulable"`
	CPUMillis     int64  `firestore:"cpuMillis"`
	MemoryBytes   int64  `firestore:"memoryBytes"`
	// Summed pod requests of pods that still occupy the node.
	RequestedCPUMillis   int64 `firestore:"requestedCpuMillis"`
	RequestedMemoryBytes int64 `firestore:"requestedMemoryBytes"`
	// metrics-server's last sample for the node; absent when it reported
	// none or the executor may not read it.
	UsedCPUMillis   *int64 `firestore:"usedCpuMillis,omitempty"`
	UsedMemoryBytes *int64 `firestore:"usedMemoryBytes,omitempty"`
	// ARC runner pods and queue executor Job pods occupying the node.
	RunnerPods   int `firestore:"runnerPods"`
	QueueJobPods int `firestore:"queueJobPods"`
}

// contentKey keeps load out of the change test: requests move with every pod
// start and stop, and the heartbeat already refreshes them once a minute.
// A host joining, leaving, going NotReady or draining writes at once, as
// does a runner starting, stopping, or changing state or job.
func (s consoleHostStatus) contentKey() any {
	type structural struct {
		name                 string
		ready, unschedulable bool
		cpu, memory          int64
	}
	type runner struct {
		name, state, runID, job string
		workflowRunID           int64
	}
	key := struct {
		hosts     []structural
		runners   []runner
		jobsKnown bool
	}{hosts: []structural{}}
	if s.Inventory != nil {
		for _, host := range s.Inventory.Hosts {
			key.hosts = append(key.hosts, structural{host.Name, host.Ready, host.Unschedulable, host.CPUMillis, host.MemoryBytes})
		}
		for _, r := range s.Inventory.Runners {
			key.runners = append(key.runners, runner{r.Name, r.State, r.RunID, r.JobRepository + "/" + r.JobName, r.WorkflowRunID})
		}
		key.jobsKnown = s.Inventory.RunnerJobsKnown
	}
	return key
}

type nodeUsage struct{ cpuMillis, memoryBytes int64 }

// nodeUsageReader returns metrics-server's latest sample per node name.
type nodeUsageReader func(context.Context) (map[string]nodeUsage, error)

const nodeMetricsPath = "/apis/metrics.k8s.io/v1beta1/nodes"

// metricsServerUsage reads node usage through the clientset's discovery
// REST client, so no metrics clientset dependency is needed for one list.
func metricsServerUsage(client kubernetes.Interface) nodeUsageReader {
	rest := client.Discovery().RESTClient()
	if rest == nil {
		return nil
	}
	return func(ctx context.Context) (map[string]nodeUsage, error) {
		raw, err := rest.Get().AbsPath(nodeMetricsPath).Do(ctx).Raw()
		if err != nil {
			return nil, err
		}
		return parseNodeMetrics(raw)
	}
}

func parseNodeMetrics(raw []byte) (map[string]nodeUsage, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Usage map[string]string `json:"usage"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decoding node metrics: %w", err)
	}
	usage := make(map[string]nodeUsage, len(list.Items))
	for _, item := range list.Items {
		cpu, err := resource.ParseQuantity(item.Usage["cpu"])
		if err != nil {
			return nil, fmt.Errorf("node %s cpu usage: %w", item.Metadata.Name, err)
		}
		memory, err := resource.ParseQuantity(item.Usage["memory"])
		if err != nil {
			return nil, fmt.Errorf("node %s memory usage: %w", item.Metadata.Name, err)
		}
		usage[item.Metadata.Name] = nodeUsage{cpuMillis: cpu.MilliValue(), memoryBytes: memory.Value()}
	}
	return usage, nil
}

// applyNodeUsage attaches each host's live sample. A node metrics-server has
// not sampled yet keeps requests alone rather than reading as idle.
func applyNodeUsage(inventory *consoleHostInventory, usage map[string]nodeUsage) {
	for i := range inventory.Hosts {
		host := &inventory.Hosts[i]
		if sample, ok := usage[host.Name]; ok {
			cpu, memory := sample.cpuMillis, sample.memoryBytes
			host.UsedCPUMillis, host.UsedMemoryBytes = &cpu, &memory
		}
	}
}

// hostInventory reads every node and pod once and accounts requests like
// nodesFit does: failed and succeeded pods release capacity, terminating
// pods still hold it.
func hostInventory(ctx context.Context, client kubernetes.Interface) (*consoleHostInventory, error) {
	nodes, err := client.CoreV1().Nodes().List(ctx, meta.ListOptions{})
	if err != nil {
		return nil, err
	}
	if len(nodes.Items) > maxConsoleHosts {
		return nil, fmt.Errorf("cluster has %d nodes; the console draws at most %d", len(nodes.Items), maxConsoleHosts)
	}
	pods, err := client.CoreV1().Pods("").List(ctx, meta.ListOptions{})
	if err != nil {
		return nil, err
	}
	hosts := make(map[string]*consoleHost, len(nodes.Items))
	inventory := &consoleHostInventory{Hosts: make([]consoleHost, 0, len(nodes.Items))}
	for _, node := range nodes.Items {
		ready := false
		for _, c := range node.Status.Conditions {
			if c.Type == core.NodeReady && c.Status == core.ConditionTrue {
				ready = true
			}
		}
		inventory.Hosts = append(inventory.Hosts, consoleHost{
			Name:          node.Name,
			Ready:         ready,
			Unschedulable: node.Spec.Unschedulable,
			CPUMillis:     node.Status.Allocatable.Cpu().MilliValue(),
			MemoryBytes:   node.Status.Allocatable.Memory().Value(),
		})
	}
	sort.Slice(inventory.Hosts, func(i, j int) bool { return inventory.Hosts[i].Name < inventory.Hosts[j].Name })
	for i := range inventory.Hosts {
		hosts[inventory.Hosts[i].Name] = &inventory.Hosts[i]
	}
	inventory.Runners = []consoleRunner{}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Status.Phase == core.PodSucceeded || pod.Status.Phase == core.PodFailed {
			continue
		}
		if runner, ok := runnerFromPod(pod, hosts); ok {
			inventory.Runners = append(inventory.Runners, runner)
		}
		host := hosts[pod.Spec.NodeName]
		if host == nil {
			continue
		}
		requests := podresource.PodRequests(pod, podresource.PodResourcesOptions{})
		host.RequestedCPUMillis += requests.Cpu().MilliValue()
		host.RequestedMemoryBytes += requests.Memory().Value()
		if pod.Labels[arcScaleSetLabel] != "" && pod.Labels[arcComponentKey] == arcRunnerValue {
			host.RunnerPods++
		}
		if pod.Labels[queueJobLabel] == "true" {
			host.QueueJobPods++
		}
	}
	if len(inventory.Runners) > maxConsoleRunners {
		inventory.Runners = nil
	} else {
		sortRunners(inventory.Runners)
	}
	return inventory, nil
}

type hostStatusPublisher interface {
	PublishHosts(context.Context, consoleHostStatus)
}

// runHostStatusPublisher samples the inventory on the console status tick. A
// failed inventory read publishes nothing, so the last good document expires
// instead of showing a plausible fleet. A failed usage read only drops the
// live sample: requests are still true, and the console labels them so.
func runHostStatusPublisher(ctx context.Context, publisher hostStatusPublisher, client kubernetes.Interface, logger *slog.Logger) {
	readUsage := metricsServerUsage(client)
	readJobs := ephemeralRunnerJobs(client)
	// A standing usage or job failure (no RBAC, no metrics-server, an
	// aggregator 503 while metrics-server is down, no ARC CRDs) is logged
	// when it starts or changes, not every tick.
	lastUsageErr, lastJobsErr := "", ""
	publish := func() {
		readCtx, cancel := context.WithTimeout(ctx, consoleStatusTimeout)
		defer cancel()
		inventory, err := hostInventory(readCtx, client)
		if err != nil {
			logger.Warn("Host inventory unavailable", slog.Any("error", err))
			return
		}
		if readUsage != nil {
			usage, err := readUsage(readCtx)
			if err == nil {
				lastUsageErr = ""
				applyNodeUsage(inventory, usage)
			} else if msg := err.Error(); msg != lastUsageErr {
				lastUsageErr = msg
				if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
					logger.Info("Host usage unavailable; publishing requests only", slog.Any("error", err))
				} else {
					logger.Warn("Host usage read failed; publishing requests only", slog.Any("error", err))
				}
			}
		}
		if readJobs != nil && inventory.Runners != nil {
			// Its own budget: a slow node or pod list must not time this
			// read out and flip every ARC runner to online and back.
			jobsCtx, cancelJobs := context.WithTimeout(ctx, consoleStatusTimeout)
			jobs, err := readJobs(jobsCtx)
			cancelJobs()
			if err == nil {
				lastJobsErr = ""
				applyRunnerJobs(inventory, jobs)
			} else if msg := err.Error(); msg != lastJobsErr {
				lastJobsErr = msg
				if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
					logger.Info("ARC runner jobs unavailable; publishing runners without jobs", slog.Any("error", err))
				} else {
					logger.Warn("ARC runner job read failed; publishing runners without jobs", slog.Any("error", err))
				}
			}
		}
		now := time.Now()
		publisher.PublishHosts(ctx, consoleHostStatus{
			SchemaVersion: 1, Kind: "hosts", Inventory: inventory,
			UpdatedAt: now.UTC().Format(time.RFC3339Nano), ExpireAt: now.Add(consoleStatusTTL),
		})
	}
	publish()
	ticker := time.NewTicker(consoleStatusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publish()
		}
	}
}
