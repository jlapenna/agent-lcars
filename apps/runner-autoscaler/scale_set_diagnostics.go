package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

// Allowlist job metadata: never serialize a session, AcquireJobURL, or JIT
// configuration. Those can contain bearer credentials (Support #4758522).
type diagnosticJob struct {
	RunnerRequestID    int64     `json:"runnerRequestId"`
	JobID              string    `json:"jobId"`
	WorkflowRunID      int64     `json:"workflowRunId"`
	OwnerName          string    `json:"ownerName"`
	RepositoryName     string    `json:"repositoryName"`
	JobWorkflowRef     string    `json:"jobWorkflowRef"`
	JobDisplayName     string    `json:"jobDisplayName"`
	QueueTime          time.Time `json:"queueTime"`
	ScaleSetAssignTime time.Time `json:"scaleSetAssignTime"`
	RunnerAssignTime   time.Time `json:"runnerAssignTime"`
	FinishTime         time.Time `json:"finishTime"`
	RunnerID           int       `json:"runnerId,omitempty"`
	RunnerName         string    `json:"runnerName,omitempty"`
	Result             string    `json:"result,omitempty"`
}

func diagnosticJobBase(j scaleset.JobMessageBase) diagnosticJob {
	return diagnosticJob{RunnerRequestID: j.RunnerRequestID, JobID: j.JobID, WorkflowRunID: j.WorkflowRunID,
		OwnerName: j.OwnerName, RepositoryName: j.RepositoryName, JobWorkflowRef: j.JobWorkflowRef,
		JobDisplayName: j.JobDisplayName, QueueTime: j.QueueTime, ScaleSetAssignTime: j.ScaleSetAssignTime,
		RunnerAssignTime: j.RunnerAssignTime, FinishTime: j.FinishTime}
}

// The deployed logger uses TextHandler. Encode arrays explicitly so their
// field names survive logfmt formatting; JSON handlers retain the same schema.
type diagnosticJobs []diagnosticJob

func (jobs diagnosticJobs) LogValue() slog.Value {
	encoded, _ := json.Marshal(jobs) // fixed scalar fields, no unsupported values
	return slog.StringValue(string(encoded))
}

func logScaleSetBatch(logger *slog.Logger, message *scaleset.RunnerScaleSetMessage) {
	available, assigned, started, completed := diagnosticJobs{}, diagnosticJobs{}, diagnosticJobs{}, diagnosticJobs{}
	for _, j := range message.JobAvailableMessages {
		if j != nil {
			available = append(available, diagnosticJobBase(j.JobMessageBase))
		}
	}
	for _, j := range message.JobAssignedMessages {
		if j != nil {
			assigned = append(assigned, diagnosticJobBase(j.JobMessageBase))
		}
	}
	for _, j := range message.JobStartedMessages {
		if j != nil {
			d := diagnosticJobBase(j.JobMessageBase)
			d.RunnerID = j.RunnerID
			d.RunnerName = j.RunnerName
			started = append(started, d)
		}
	}
	for _, j := range message.JobCompletedMessages {
		if j != nil {
			d := diagnosticJobBase(j.JobMessageBase)
			d.RunnerID = j.RunnerID
			d.RunnerName = j.RunnerName
			d.Result = j.Result
			completed = append(completed, d)
		}
	}
	logger.Info("Scale-set batch received", slog.Bool("initial", message.MessageID == listener.InitialMessageID),
		diagnosticStatistics(message.Statistics), slog.Any("job_available", available), slog.Any("job_assigned", assigned), slog.Any("job_started", started), slog.Any("job_completed", completed))
}

type scaleDiagnosticLoggerKey struct{}

func scaleDiagnosticLogger(ctx context.Context, fallback *slog.Logger) *slog.Logger {
	if logger, ok := ctx.Value(scaleDiagnosticLoggerKey{}).(*slog.Logger); ok {
		return logger
	}
	return fallback
}

// Wrap the library's acknowledgment boundary, not Scale's successful return:
// only a successful DeleteMessage proves GitHub accepted the acknowledgment.
type diagnosticSessionClient struct {
	listener.Client
	logger *slog.Logger
}

func (c *diagnosticSessionClient) DeleteMessage(ctx context.Context, messageID int) error {
	err := c.Client.DeleteMessage(ctx, messageID)
	if err != nil {
		c.logger.Error("Scale-set batch acknowledgment failed", slog.Int("message_id", messageID))
		return err
	}
	c.logger.Info("Scale-set batch acknowledged", slog.Int("message_id", messageID))
	return nil
}

func (c *diagnosticSessionClient) GetMessage(ctx context.Context, lastMessageID, maxCapacity int) (*scaleset.RunnerScaleSetMessage, error) {
	message, err := c.Client.GetMessage(ctx, lastMessageID, maxCapacity)
	if err != nil {
		c.logger.Error("Scale-set message polling failed", slog.Int("last_message_id", lastMessageID), slog.Int("max_capacity", maxCapacity))
	}
	return message, err
}

func diagnosticStatistics(stats *scaleset.RunnerScaleSetStatistic) slog.Attr {
	if stats == nil {
		return slog.Any("statistics", nil)
	}
	return slog.Group("statistics", slog.Int("totalAvailableJobs", stats.TotalAvailableJobs),
		slog.Int("totalAcquiredJobs", stats.TotalAcquiredJobs), slog.Int("totalAssignedJobs", stats.TotalAssignedJobs),
		slog.Int("totalRunningJobs", stats.TotalRunningJobs), slog.Int("totalRegisteredRunners", stats.TotalRegisteredRunners),
		slog.Int("totalBusyRunners", stats.TotalBusyRunners), slog.Int("totalIdleRunners", stats.TotalIdleRunners))
}
