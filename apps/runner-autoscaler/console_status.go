package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"cloud.google.com/go/firestore"
)

// runnerStatusCollection is intentionally shared with the console's
// read-only telemetry client. A document is overwritten for each scale set,
// so this registration channel has bounded storage even when a runner fleet
// is busy for months.
const runnerStatusCollection = "runner-status"

// queueExecutorStatusDocument is deliberately a reserved, non-scale-set
// document in the same bounded telemetry collection.  Keeping queue-executor
// health beside (rather than inside) a scale-set snapshot prevents a direct
// runner from being mistaken for a GitHub-registered runner, while avoiding a
// second operational store.
const queueExecutorStatusDocument = "queue-executor"

const (
	consoleStatusInterval = 10 * time.Second
	consoleStatusTimeout  = 5 * time.Second
)

// consoleRunnerStatus is the deliberately small operational projection the
// console needs. It contains no checkout, command, token, or container
// internals: runner names, host placement, and the opaque GitHub job ID are
// enough to answer "what is the autoscaler doing right now?".
type consoleRunnerStatus struct {
	Name  string `firestore:"name"`
	Host  string `firestore:"host"`
	State string `firestore:"state"`
	JobID string `firestore:"jobId,omitempty"`
}

type consoleScaleSetStatus struct {
	SchemaVersion   int                   `firestore:"schemaVersion"`
	ScaleSet        string                `firestore:"scaleSet"`
	Registration    string                `firestore:"registration"`
	RegistrationURL string                `firestore:"registrationUrl,omitempty"`
	QueuedJobs      int64                 `firestore:"queuedJobs"`
	MinRunners      int                   `firestore:"minRunners"`
	MaxRunners      int                   `firestore:"maxRunners"`
	Draining        bool                  `firestore:"draining"`
	Runners         []consoleRunnerStatus `firestore:"runners"`
	UpdatedAt       string                `firestore:"updatedAt"`
	ExpireAt        time.Time             `firestore:"expireAt"`
}

// consoleQueueExecutorStatus is the generic direct-executor health
// projection. It intentionally has no repository, pipeline, credential, or
// individual-run fields: durable queue/claim/run lifecycle belongs to the
// orchestrator Run record, and provider-specific details belong behind the
// direct-runner adapter.
//
// SchemaVersion 2 plus Kind makes this safely distinguishable from the
// existing scale-set schema (v1). Older console readers reject this document
// rather than treating it as a malformed scale set; newer readers can accept
// both independently.
type consoleQueueExecutorStatus struct {
	SchemaVersion int       `firestore:"schemaVersion"`
	Kind          string    `firestore:"kind"`
	Executor      string    `firestore:"executor"`
	Ready         bool      `firestore:"ready"`
	Draining      bool      `firestore:"draining"`
	ActiveRuns    *int      `firestore:"activeRuns,omitempty"`
	MaxConcurrent int       `firestore:"maxConcurrent"`
	UpdatedAt     string    `firestore:"updatedAt"`
	ExpireAt      time.Time `firestore:"expireAt"`
}

// consoleStatusPublisher abstracts the writer for tests and keeps status
// telemetry isolated from the placement/listener critical path.
type consoleStatusPublisher interface {
	Publish(context.Context, consoleScaleSetStatus)
	PublishQueueExecutor(context.Context, consoleQueueExecutorStatus)
	Enabled() bool
	Close() error
}

type noopConsoleStatusPublisher struct{}

func (noopConsoleStatusPublisher) Publish(context.Context, consoleScaleSetStatus) {}
func (noopConsoleStatusPublisher) PublishQueueExecutor(context.Context, consoleQueueExecutorStatus) {
}
func (noopConsoleStatusPublisher) Enabled() bool { return false }
func (noopConsoleStatusPublisher) Close() error  { return nil }

type firestoreConsoleStatusPublisher struct {
	client *firestore.Client
	logger *slog.Logger
	// A single slot per scale set coalesces rapid listener transitions. The
	// autoscaler never waits for Firestore, and the next 10-second snapshot
	// heals any dropped write after a transient outage.
	pending sync.Map // map[string]consoleScaleSetStatus | consoleQueueExecutorStatus
	wake    chan struct{}
	closed  atomic.Bool
}

func newConsoleStatusPublisher(ctx context.Context, logger *slog.Logger) (consoleStatusPublisher, error) {
	// Disabled by default: existing deployments keep their exact startup and
	// credential behaviour until the homelab deploy opts in. The writer is the
	// already-scoped telemetry-writer identity; no console write permission or
	// new Terraform resource is needed.
	if strings.ToLower(strings.TrimSpace(os.Getenv("AGENT_LCARS_AUTOSCALER_STATUS_ENABLED"))) != "true" {
		return noopConsoleStatusPublisher{}, nil
	}
	projectID := strings.TrimSpace(os.Getenv("AGENT_TELEMETRY_PROJECT_ID"))
	if projectID == "" {
		return nil, fmt.Errorf("AGENT_TELEMETRY_PROJECT_ID is required when AGENT_LCARS_AUTOSCALER_STATUS_ENABLED=true")
	}
	databaseID := strings.TrimSpace(os.Getenv("AGENT_TELEMETRY_DATABASE_ID"))
	if databaseID == "" {
		databaseID = "(default)"
	}
	client, err := firestore.NewClientWithDatabase(ctx, projectID, databaseID)
	if err != nil {
		return nil, err
	}
	publisher := &firestoreConsoleStatusPublisher{client: client, logger: logger, wake: make(chan struct{}, 1)}
	go publisher.run(ctx)
	return publisher, nil
}

func (p *firestoreConsoleStatusPublisher) Publish(_ context.Context, status consoleScaleSetStatus) {
	p.publish(status.ScaleSet, status)
}

func (p *firestoreConsoleStatusPublisher) PublishQueueExecutor(_ context.Context, status consoleQueueExecutorStatus) {
	p.publish(queueExecutorStatusDocument, status)
}

func (p *firestoreConsoleStatusPublisher) Enabled() bool { return true }

func (p *firestoreConsoleStatusPublisher) publish(name string, status any) {
	if p.closed.Load() {
		return
	}
	p.pending.Store(name, status)
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *firestoreConsoleStatusPublisher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
		}
		p.pending.Range(func(key, value any) bool {
			name := key.(string)
			writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), consoleStatusTimeout)
			_, err := p.client.Collection(runnerStatusCollection).Doc(name).Set(writeCtx, value)
			cancel()
			if err != nil {
				p.logger.Warn("Failed to publish autoscaler status to the console; placement continues", slog.String("scale_set", name), slog.String("error", err.Error()))
				return true
			}
			p.pending.Delete(name)
			return true
		})
	}
}

func (p *firestoreConsoleStatusPublisher) Close() error {
	p.closed.Store(true)
	return p.client.Close()
}

// consoleStatusSnapshot is lock-contained so the status publisher can never
// observe a half-transition between the idle and busy maps.
func (a *Scaler) consoleStatusSnapshot(now time.Time) consoleScaleSetStatus {
	a.runners.mu.Lock()
	runners := make([]consoleRunnerStatus, 0, len(a.runners.idle)+len(a.runners.busy))
	for name, ref := range a.runners.idle {
		runners = append(runners, consoleRunnerStatus{Name: name, Host: ref.host, State: "idle"})
	}
	for name, ref := range a.runners.busy {
		runners = append(runners, consoleRunnerStatus{Name: name, Host: ref.host, State: "busy", JobID: ref.jobID})
	}
	a.runners.mu.Unlock()
	sort.Slice(runners, func(i, j int) bool { return runners[i].Name < runners[j].Name })
	return consoleScaleSetStatus{
		SchemaVersion: 1, ScaleSet: a.scaleSetLabel(), Registration: a.registrationName, RegistrationURL: a.registrationURL,
		QueuedJobs: a.queuedJobs.Load(), MinRunners: a.minRunners, MaxRunners: a.maxRunners,
		Draining: a.draining.Load(), Runners: runners, UpdatedAt: now.UTC().Format(time.RFC3339Nano),
		// The console treats this as a presentation staleness boundary. It is
		// intentionally not a Firestore TTL field: the collection is bounded
		// by scale-set name and never accumulates historical documents.
		ExpireAt: now.Add(3 * consoleStatusInterval),
	}
}

func runConsoleStatusPublisher(ctx context.Context, runtimes []*scaleSetRuntime, publisher consoleStatusPublisher) {
	publish := func() {
		now := time.Now()
		for _, runtime := range runtimes {
			publisher.Publish(ctx, runtime.scaler.consoleStatusSnapshot(now))
		}
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
