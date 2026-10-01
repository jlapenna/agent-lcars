package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"cloud.google.com/go/firestore"
)

// runnerStatusCollection is intentionally shared with the console's
// read-only telemetry client.
const runnerStatusCollection = "runner-status"

// queueExecutorStatusDocument is a reserved document name in the shared
// runner-status telemetry collection. It used to live alongside one document
// per scale set (schemaVersion 1); homelab#1623 Phase 3 retired the
// scale-set runtime that published those, so this is the only document this
// process writes now. The console (apps/console/src/lib/autoscaler-status.ts)
// reads the whole collection and tolerates either shape -- or neither, if a
// document has gone stale -- so no console change was needed for the
// per-scale-set documents to simply stop being written.
const queueExecutorStatusDocument = "queue-executor"

const (
	consoleStatusInterval = 10 * time.Second
	consoleStatusTimeout  = 5 * time.Second
)

// consoleQueueExecutorStatus is the generic direct-executor health
// projection. It intentionally has no repository, pipeline, credential, or
// individual-run fields: durable queue/claim/run lifecycle belongs to the
// orchestrator Run record, and provider-specific details belong behind the
// direct-runner adapter.
//
// SchemaVersion 2 plus Kind makes this safely distinguishable from the
// retired scale-set schema (v1), which an older console reader could
// otherwise mistake this for.
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
// telemetry isolated from the queue executor's claim/launch critical path.
type consoleStatusPublisher interface {
	PublishQueueExecutor(context.Context, consoleQueueExecutorStatus)
	Enabled() bool
	Close() error
}

type noopConsoleStatusPublisher struct{}

func (noopConsoleStatusPublisher) PublishQueueExecutor(context.Context, consoleQueueExecutorStatus) {
}
func (noopConsoleStatusPublisher) Enabled() bool { return false }
func (noopConsoleStatusPublisher) Close() error  { return nil }

type firestoreConsoleStatusPublisher struct {
	client *firestore.Client
	logger *slog.Logger
	// A single slot coalesces rapid status transitions. The autoscaler never
	// waits for Firestore, and the next 10-second snapshot heals any dropped
	// write after a transient outage.
	pending sync.Map // map[string]consoleQueueExecutorStatus
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
				p.logger.Warn("Failed to publish autoscaler status to the console; queue executor continues", slog.String("document", name), slog.String("error", err.Error()))
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
