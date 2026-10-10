package main

import (
	"context"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/firestore"
	firestorepb "cloud.google.com/go/firestore/apiv1/firestorepb"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// This sink observes the real pinned SDK's Commit wire payload. It owns an
// ephemeral loopback listener, uses no ADC, and never writes to Firestore.
type queueClaimCommitSink struct {
	firestorepb.UnimplementedFirestoreServer
	mu       sync.Mutex
	requests []*firestorepb.CommitRequest
}

func (s *queueClaimCommitSink) Commit(_ context.Context, request *firestorepb.CommitRequest) (*firestorepb.CommitResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, request)
	results := make([]*firestorepb.WriteResult, len(request.Writes))
	for i := range results {
		results[i] = &firestorepb.WriteResult{UpdateTime: timestamppb.Now()}
	}
	return &firestorepb.CommitResponse{CommitTime: timestamppb.Now(), WriteResults: results}, nil
}

func TestQueueClaimWindowFirestoreCommitEncoding(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	sink := &queueClaimCommitSink{}
	firestorepb.RegisterFirestoreServer(server, sink)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { server.Stop(); _ = listener.Close() })
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	client, err := firestore.NewClient(ctx, "demo-queue-claim-encoding", option.WithGRPCConn(conn), option.WithoutAuthentication())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	doc := client.Collection(runnerStatusCollection).Doc(queueExecutorStatusDocument)
	start := time.Date(2026, 10, 10, 5, 23, 42, 123456000, time.UTC)
	var commitCount int
	for _, value := range []uint64{0, 1, 9007199254740991} {
		t.Run(strconv.FormatUint(value, 10), func(t *testing.T) {
			counts := [3]uint64{}
			// Exercise the production emitter, including its first nil baseline.
			source := &queueExecutorStatusSource{claimCounters: func() ([3]uint64, error) { return counts, nil }}
			source.configureCapacity(5, func(context.Context) (int, error) { return 2, nil })
			source.ready.Store(true)
			baseline := source.snapshot(ctx, start)
			counts = [3]uint64{value, value, value}
			end := start.Add(consoleStatusInterval)
			measured := source.snapshot(ctx, end)
			for _, status := range []consoleQueueExecutorStatus{baseline, measured} {
				if _, err := doc.Set(ctx, status); err != nil {
					t.Fatalf("emitted claims=%#v must reach Commit: %v", status.Claims, err)
				}
				commitCount++
				sink.mu.Lock()
				requests := append([]*firestorepb.CommitRequest(nil), sink.requests...)
				sink.mu.Unlock()
				if len(requests) != commitCount || len(requests[commitCount-1].Writes) != 1 {
					t.Fatalf("expected one Commit/write per emitted sample, got %#v", requests)
				}
				update := requests[commitCount-1].Writes[0].GetUpdate()
				if update.GetName() != doc.Path {
					t.Fatalf("wrong status document: %s", update.GetName())
				}
				fields := update.GetFields()
				assertQueueClaimInteger(t, fields, "schemaVersion", 2)
				assertQueueClaimInteger(t, fields, "maxConcurrent", 5)
				assertQueueClaimInteger(t, fields, "activeRuns", 2)
				if fields["updatedAt"].GetStringValue() != status.UpdatedAt || !fields["expireAt"].GetTimestampValue().AsTime().Equal(status.ExpireAt) || fields["kind"].GetStringValue() != "queue-executor" || fields["executor"].GetStringValue() != "queue" || !fields["ready"].GetBooleanValue() || fields["draining"].GetBooleanValue() {
					t.Fatalf("status metadata changed: %v", fields)
				}
				if status.Claims == nil {
					if _, present := fields["claims"]; present {
						t.Fatal("initial baseline must omit claims")
					}
					continue
				}
				claims := fields["claims"].GetMapValue().GetFields()
				for _, name := range []string{"claude", "codex", "opencode"} {
					assertQueueClaimInteger(t, claims, name, int64(value))
				}
				if len(claims) != 5 || claims["windowStart"].GetStringValue() != start.Format(time.RFC3339Nano) || claims["windowEnd"].GetStringValue() != end.Format(time.RFC3339Nano) {
					t.Fatalf("wrong observed window: %v", claims)
				}
			}
		})
	}
}

func assertQueueClaimInteger(t *testing.T, fields map[string]*firestorepb.Value, name string, want int64) {
	t.Helper()
	integer, ok := fields[name].GetValueType().(*firestorepb.Value_IntegerValue)
	if !ok || integer.IntegerValue != want {
		t.Fatalf("%s must be exact integer_value %d, got %v", name, want, fields[name])
	}
}
