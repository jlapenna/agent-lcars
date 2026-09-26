package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	"github.com/google/uuid"
)

func TestScaleBatchDiagnosticsPrecedeAcquisitionFailure(t *testing.T) {
	var logs bytes.Buffer
	scaler := &Scaler{scaleSetName: "test", logger: slog.New(slog.NewJSONHandler(&logs, nil)),
		messageSessionClient: &fakeMessageSessionClient{acquireErr: errors.New("rejected")}}
	base := scaleset.JobMessageBase{JobID: "job-123", WorkflowRunID: 456, RunnerRequestID: 789, JobDisplayName: "Verify"}
	err := scaler.Scale(context.Background(), &scaleset.RunnerScaleSetMessage{MessageID: 42,
		Statistics:           &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 3},
		JobAvailableMessages: []*scaleset.JobAvailable{{AcquireJobURL: "https://private.invalid/?token=SECRET", JobMessageBase: base}},
		JobAssignedMessages:  []*scaleset.JobAssigned{{JobMessageBase: base}},
		JobStartedMessages:   []*scaleset.JobStarted{{JobMessageBase: base, RunnerID: 9, RunnerName: "runner-test"}},
		JobCompletedMessages: []*scaleset.JobCompleted{{JobMessageBase: base, RunnerID: 9, RunnerName: "runner-test", Result: "success"}},
	})
	if err == nil {
		t.Fatal("expected acquisition failure")
	}
	if strings.Contains(logs.String(), "SECRET") || strings.Contains(logs.String(), "acquireJobUrl") {
		t.Fatal("credential-bearing URL leaked")
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	var record map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatal(err)
	}
	if record["msg"] != "Scale-set batch received" || record["message_id"] != float64(42) {
		t.Fatalf("batch missing before processing: %v", record)
	}
	for _, field := range []string{"job_available", "job_assigned", "job_started", "job_completed"} {
		var jobs []any
		if err := json.Unmarshal([]byte(record[field].(string)), &jobs); err != nil {
			t.Fatal(err)
		}
		job := jobs[0].(map[string]any)
		if job["jobId"] != "job-123" || job["workflowRunId"] != float64(456) || job["runnerRequestId"] != float64(789) {
			t.Fatalf("lost %s identities: %v", field, job)
		}
	}
	if !strings.Contains(lines[len(lines)-1], "Scale-set batch processing failed") {
		t.Fatal("missing processing failure")
	}
}

type diagnosticTestClient struct {
	listener.Client
	ackErr error
	calls  int
	cancel context.CancelFunc
}

func (c *diagnosticTestClient) Session() scaleset.RunnerScaleSetSession {
	return scaleset.RunnerScaleSetSession{SessionID: uuid.MustParse("11111111-1111-1111-1111-111111111111"), Statistics: &scaleset.RunnerScaleSetStatistic{}, MessageQueueAccessToken: "SECRET"}
}
func (c *diagnosticTestClient) GetMessage(context.Context, int, int) (*scaleset.RunnerScaleSetMessage, error) {
	return &scaleset.RunnerScaleSetMessage{MessageID: 42, Statistics: &scaleset.RunnerScaleSetStatistic{}}, nil
}
func (c *diagnosticTestClient) DeleteMessage(context.Context, int) error {
	c.calls++
	c.cancel()
	return c.ackErr
}

type diagnosticTestScaler struct {
	fail bool
	log  *slog.Logger
}

func (s diagnosticTestScaler) Scale(_ context.Context, m *scaleset.RunnerScaleSetMessage) error {
	if m.MessageID == listener.InitialMessageID {
		return nil
	}
	s.log.Info("processed")
	if s.fail {
		return errors.New("processing failed")
	}
	return nil
}

func TestDiagnosticAcknowledgmentFollowsActualListenerProcessing(t *testing.T) {
	for _, mode := range []string{"success", "ack failure", "processing failure"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client := &diagnosticTestClient{cancel: cancel}
			if mode == "ack failure" {
				client.ackErr = errors.New("SECRET transport failure")
			}
			wrapped := &diagnosticSessionClient{Client: client, logger: logger.With("session_id", client.Session().SessionID.String())}
			l, err := listener.New(wrapped, listener.Config{ScaleSetID: 1, MaxRunners: 1, Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			_ = l.Run(ctx, diagnosticTestScaler{fail: mode == "processing failure", log: logger})
			output := logs.String()
			if strings.Contains(output, "SECRET") {
				t.Fatal("raw error or session credential leaked")
			}
			if mode == "processing failure" {
				if client.calls != 0 || strings.Contains(output, "acknowledged") {
					t.Fatal("acknowledged unprocessed message")
				}
				return
			}
			if client.calls != 1 {
				t.Fatalf("ack calls=%d", client.calls)
			}
			expected := "Scale-set batch acknowledged"
			if mode == "ack failure" {
				expected = "Scale-set batch acknowledgment failed"
				if strings.Contains(output, "batch acknowledged") {
					t.Fatal("claimed failed ack succeeded")
				}
			}
			if strings.Index(output, "processed") > strings.Index(output, expected) || !strings.Contains(output, expected) {
				t.Fatalf("incorrect acknowledgment order: %s", output)
			}
		})
	}
}
