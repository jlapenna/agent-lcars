package main

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/firestore"
	firestorepb "cloud.google.com/go/firestore/apiv1/firestorepb"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// lostRunSessionsSink serves one session doc to the real pinned SDK over an
// ephemeral loopback listener, so the adapter's query filter, transactional
// re-read, and Commit payload are observed on the wire. It uses no ADC and
// never reaches Firestore.
type lostRunSessionsSink struct {
	firestorepb.UnimplementedFirestoreServer
	doc *firestorepb.Document

	mu      sync.Mutex
	queries []*firestorepb.RunQueryRequest
	commits []*firestorepb.CommitRequest
}

func (s *lostRunSessionsSink) RunQuery(request *firestorepb.RunQueryRequest, stream firestorepb.Firestore_RunQueryServer) error {
	s.mu.Lock()
	s.queries = append(s.queries, request)
	s.mu.Unlock()
	return stream.Send(&firestorepb.RunQueryResponse{Document: s.doc, ReadTime: timestamppb.Now()})
}

func (s *lostRunSessionsSink) BeginTransaction(context.Context, *firestorepb.BeginTransactionRequest) (*firestorepb.BeginTransactionResponse, error) {
	return &firestorepb.BeginTransactionResponse{Transaction: []byte("tx-1")}, nil
}

func (s *lostRunSessionsSink) BatchGetDocuments(request *firestorepb.BatchGetDocumentsRequest, stream firestorepb.Firestore_BatchGetDocumentsServer) error {
	for range request.Documents {
		if err := stream.Send(&firestorepb.BatchGetDocumentsResponse{Result: &firestorepb.BatchGetDocumentsResponse_Found{Found: s.doc}, ReadTime: timestamppb.Now()}); err != nil {
			return err
		}
	}
	return nil
}

func (s *lostRunSessionsSink) Commit(_ context.Context, request *firestorepb.CommitRequest) (*firestorepb.CommitResponse, error) {
	s.mu.Lock()
	s.commits = append(s.commits, request)
	s.mu.Unlock()
	results := make([]*firestorepb.WriteResult, len(request.Writes))
	for i := range results {
		results[i] = &firestorepb.WriteResult{UpdateTime: timestamppb.Now()}
	}
	return &firestorepb.CommitResponse{CommitTime: timestamppb.Now(), WriteResults: results}, nil
}

func (s *lostRunSessionsSink) Rollback(context.Context, *firestorepb.RollbackRequest) (*emptypb.Empty, error) {
	return &emptypb.Empty{}, nil
}

func TestLostRunSessionsFirestoreAdapterWire(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	const projectID = "demo-lost-run-sessions"
	docName := "projects/" + projectID + "/databases/(default)/documents/" + sessionsCollection + "/ses_ecda6d5abffe0pGYZYD2MGOhtY"
	writtenAt := time.Date(2026, 10, 12, 23, 15, 0, 0, time.UTC)
	sink := &lostRunSessionsSink{doc: &firestorepb.Document{
		Name: docName,
		Fields: map[string]*firestorepb.Value{
			"runId":    {ValueType: &firestorepb.Value_StringValue{StringValue: lostRunID}},
			"liveness": {ValueType: &firestorepb.Value_StringValue{StringValue: "live"}},
		},
		CreateTime: timestamppb.New(writtenAt),
		UpdateTime: timestamppb.New(writtenAt),
	}}
	server := grpc.NewServer()
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
	client, err := firestore.NewClient(ctx, projectID, option.WithGRPCConn(conn), option.WithoutAuthentication())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ender, _ := newTestLostRunSessionEnder(firestoreLostRunSessionStore{client: client})

	ender.endRunSessions(ctx, lostRunID)

	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.queries) != 1 {
		t.Fatalf("queries = %d, want 1", len(sink.queries))
	}
	query := sink.queries[0].GetStructuredQuery()
	filter := query.GetWhere().GetFieldFilter()
	if query.GetFrom()[0].GetCollectionId() != sessionsCollection || filter.GetField().GetFieldPath() != "runId" || filter.GetOp() != firestorepb.StructuredQuery_FieldFilter_EQUAL || filter.GetValue().GetStringValue() != lostRunID {
		t.Fatalf("wrong query: %v", query)
	}
	if query.GetLimit().GetValue() != lostRunSessionsLimit {
		t.Fatalf("query limit = %v, want %d", query.GetLimit(), lostRunSessionsLimit)
	}
	if len(sink.commits) != 1 || len(sink.commits[0].Writes) != 1 {
		t.Fatalf("commits = %v, want one transactional write", sink.commits)
	}
	commit := sink.commits[0]
	if string(commit.GetTransaction()) != "tx-1" {
		t.Fatalf("write was not inside the transaction: %q", commit.GetTransaction())
	}
	write := commit.Writes[0]
	if write.GetUpdate().GetName() != docName {
		t.Fatalf("wrong document: %s", write.GetUpdate().GetName())
	}
	// Only liveness changes; every other field the hooks wrote is kept.
	if mask := write.GetUpdateMask().GetFieldPaths(); len(mask) != 1 || mask[0] != "liveness" {
		t.Fatalf("update mask = %v, want [liveness]", mask)
	}
	if fields := write.GetUpdate().GetFields(); len(fields) != 1 || fields["liveness"].GetStringValue() != "ended" {
		t.Fatalf("fields = %v, want liveness=ended", fields)
	}
}
