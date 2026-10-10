package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"reflect"
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
	// consoleStatusInterval is how often the producers sample local health.
	// Sampling is cheap and local; a Firestore write is not, so the publisher
	// writes a sample only when its content differs from the last write or
	// the heartbeat is due.
	consoleStatusInterval = 10 * time.Second
	// consoleStatusHeartbeat bounds how long an unchanged document goes
	// without a write. It is what proves the producer is still alive, so the
	// console's staleness threshold (RUNNER_STATUS_STALENESS_MS in
	// apps/console/src/lib/runner-status-contract.ts) and the document's TTL
	// are both consoleStatusTTL.
	consoleStatusHeartbeat = 60 * time.Second
	consoleStatusTTL       = 3 * consoleStatusHeartbeat
	consoleStatusTimeout   = 5 * time.Second
)

// consoleStatusDocument is one runner-status document. contentKey returns
// the document without its write-time fields (updatedAt, expireAt), so two
// samples with equal keys describe the same state.
type consoleStatusDocument interface {
	contentKey() any
}

// The publisher's sync.Map.CompareAndDelete panics at runtime on an
// uncomparable value; using each document type as a map key turns adding a
// slice or map field into a compile error instead.
var (
	_ map[consoleQueueExecutorStatus]struct{}
	_ map[consoleARCLaneStatus]struct{}
)

func (s consoleQueueExecutorStatus) contentKey() any {
	s.UpdatedAt, s.ExpireAt = "", time.Time{}
	if s.ActiveRuns != nil {
		active := *s.ActiveRuns
		s.ActiveRuns = &active
	}
	if s.Claims != nil {
		claims := *s.Claims
		// An unchanged counter difference needs only the normal heartbeat;
		// retain the exact sample window on the document that was written.
		claims.WindowStart, claims.WindowEnd = "", ""
		s.Claims = &claims
	}
	return s
}

func (s consoleARCLaneStatus) contentKey() any {
	s.UpdatedAt, s.ExpireAt = "", time.Time{}
	return s
}

// statusWriteGate decides which samples reach Firestore: a sample whose
// content changed since the last successful write, or any sample once the
// heartbeat is due. Everything else is a duplicate of a document the console
// already has. Only the publisher's single run goroutine uses it.
type statusWriteGate struct {
	heartbeat time.Duration
	written   map[string]writtenStatus
}

type writtenStatus struct {
	key any
	at  time.Time
}

func newStatusWriteGate(heartbeat time.Duration) *statusWriteGate {
	return &statusWriteGate{heartbeat: heartbeat, written: map[string]writtenStatus{}}
}

func (g *statusWriteGate) shouldWrite(name string, status consoleStatusDocument, now time.Time) bool {
	last, ok := g.written[name]
	if !ok || now.Sub(last.at) >= g.heartbeat {
		return true
	}
	return !reflect.DeepEqual(last.key, status.contentKey())
}

func (g *statusWriteGate) recordWritten(name string, status consoleStatusDocument, now time.Time) {
	g.written[name] = writtenStatus{key: status.contentKey(), at: now}
}

// consoleQueueExecutorStatus is the generic direct-executor health
// projection. Its additive provider counters are bounded metrics from the
// claim boundary; durable queue/cooldown state remains in the orchestrator.
// No credential or individual-run payload is published here.
//
// SchemaVersion 2 plus Kind makes this safely distinguishable from the
// retired scale-set schema (v1), which an older console reader could
// otherwise mistake this for.
type consoleQueueExecutorStatus struct {
	SchemaVersion int                 `firestore:"schemaVersion"`
	Kind          string              `firestore:"kind"`
	Executor      string              `firestore:"executor"`
	Ready         bool                `firestore:"ready"`
	Draining      bool                `firestore:"draining"`
	ActiveRuns    *int                `firestore:"activeRuns,omitempty"`
	MaxConcurrent int                 `firestore:"maxConcurrent"`
	UpdatedAt     string              `firestore:"updatedAt"`
	ExpireAt      time.Time           `firestore:"expireAt"`
	Claims        *consoleClaimWindow `firestore:"claims,omitempty"`
}

// A bounded difference of the existing successful-claim counters. The exact
// sampled interval is part of the contract; a restart never pretends to have
// observed the full preceding fifteen minutes.
type consoleClaimWindow struct {
	// Firestore integers are signed; uint64 is rejected even for zero.
	Claude      int64  `firestore:"claude"`
	Codex       int64  `firestore:"codex"`
	OpenCode    int64  `firestore:"opencode"`
	WindowStart string `firestore:"windowStart"`
	WindowEnd   string `firestore:"windowEnd"`
}

// consoleStatusPublisher abstracts the writer for tests and keeps status
// telemetry isolated from the queue executor's claim/launch critical path.
type consoleStatusPublisher interface {
	PublishQueueExecutor(context.Context, consoleQueueExecutorStatus)
	PublishARCLane(context.Context, consoleARCLaneStatus)
	Enabled() bool
	Close() error
}

type noopConsoleStatusPublisher struct{}

func (noopConsoleStatusPublisher) PublishQueueExecutor(context.Context, consoleQueueExecutorStatus) {
}
func (noopConsoleStatusPublisher) PublishARCLane(context.Context, consoleARCLaneStatus) {}
func (noopConsoleStatusPublisher) Enabled() bool                                        { return false }
func (noopConsoleStatusPublisher) Close() error                                         { return nil }

type firestoreConsoleStatusPublisher struct {
	client *firestore.Client
	logger *slog.Logger
	// A single slot coalesces rapid status transitions. The autoscaler never
	// waits for Firestore, and the next sample heals any dropped write after
	// a transient outage: a failed write is never recorded by the gate.
	pending sync.Map // map[string]consoleStatusDocument
	wake    chan struct{}
	closed  atomic.Bool
	gate    *statusWriteGate
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
	publisher := &firestoreConsoleStatusPublisher{client: client, logger: logger, wake: make(chan struct{}, 1), gate: newStatusWriteGate(consoleStatusHeartbeat)}
	go publisher.run(ctx)
	return publisher, nil
}

func (p *firestoreConsoleStatusPublisher) PublishQueueExecutor(_ context.Context, status consoleQueueExecutorStatus) {
	p.publish(queueExecutorStatusDocument, status)
}

func (p *firestoreConsoleStatusPublisher) PublishARCLane(_ context.Context, status consoleARCLaneStatus) {
	p.publish("arc-"+status.Lane, status)
}

func (p *firestoreConsoleStatusPublisher) Enabled() bool { return true }

func (p *firestoreConsoleStatusPublisher) publish(name string, status consoleStatusDocument) {
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
			status := value.(consoleStatusDocument)
			now := time.Now()
			if !p.gate.shouldWrite(name, status, now) {
				p.pending.CompareAndDelete(name, value)
				return true
			}
			writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), consoleStatusTimeout)
			_, err := p.client.Collection(runnerStatusCollection).Doc(name).Set(writeCtx, status)
			cancel()
			if err != nil {
				p.logger.Warn("Failed to publish autoscaler status to the console; queue executor continues", slog.String("document", name), slog.String("error", err.Error()))
				return true
			}
			p.gate.recordWritten(name, status, now)
			p.pending.CompareAndDelete(name, value)
			return true
		})
	}
}

func (p *firestoreConsoleStatusPublisher) Close() error {
	p.closed.Store(true)
	return p.client.Close()
}
