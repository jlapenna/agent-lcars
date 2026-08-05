package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// checkpointVersion is the on-disk schema version. Bump it only for a change
// the loader cannot read; loadCheckpoint discards any file carrying a
// different version rather than guessing at its shape, which degrades to
// today's Docker-derived adoption instead of misreading state.
const checkpointVersion = 1

// checkpointFlushInterval bounds how stale the fleet-telemetry half of the
// checkpoint can be. Runner idle/busy transitions do NOT wait for this --
// they flush synchronously (see Scaler.checkpoint), because a lost transition
// is exactly the misclassification the checkpoint exists to prevent. Host
// samples and overload cooldowns are merely advisory on boot, so a periodic
// flush is enough for them.
const checkpointFlushInterval = 15 * time.Second

// checkpointFile is the whole persisted control-plane state. It deliberately
// records only what a fresh process cannot re-derive from Docker or GitHub:
// the authoritative idle/busy split (Docker can report that a container
// exists, never whether GitHub has assigned it a job), plus the fleet
// telemetry whose absence silently disables pressure-based admission for the
// first sampling interval after a restart.
type checkpointFile struct {
	Version   int                           `json:"version"`
	WrittenAt time.Time                     `json:"written_at"`
	ScaleSets map[string]checkpointScaleSet `json:"scale_sets"`
	Fleet     checkpointFleet               `json:"fleet"`
}

type checkpointScaleSet struct {
	Draining bool                        `json:"draining"`
	Runners  map[string]checkpointRunner `json:"runners"`
}

// checkpointRunner mirrors runnerRef plus the busy bit. StartedAt stays the
// container creation time for the same reason runnerRef.startedAt does: a
// restart must not grant an hours-old runner a fresh startup grace period.
type checkpointRunner struct {
	Host        string    `json:"host"`
	ContainerID string    `json:"container_id"`
	StartedAt   time.Time `json:"started_at"`
	Busy        bool      `json:"busy"`
}

type checkpointFleet struct {
	OverloadedUntil map[string]time.Time            `json:"overloaded_until,omitempty"`
	HostSamples     map[string]checkpointHostSample `json:"host_samples,omitempty"`
}

type checkpointHostSample struct {
	At             time.Time `json:"at"`
	IdleSeconds    float64   `json:"idle_seconds"`
	CPUPressure    float64   `json:"cpu_pressure"`
	MemoryPressure float64   `json:"memory_pressure"`
	SwapPages      float64   `json:"swap_pages"`
}

// checkpointStore owns the checkpoint path and serializes writes to it.
//
// snapshot is installed after the runtimes exist (they are built before the
// store has anything to read) and is replaced on every config reload, so a
// flush always reads the generation that is actually live. A nil snapshot
// makes flush a no-op rather than an error: it means no runtime has been
// built yet, and there is nothing worth recording.
type checkpointStore struct {
	path   string
	logger *slog.Logger

	mu       sync.Mutex
	snapshot func() checkpointFile
	// failed suppresses repeat logging once a write has failed. A checkpoint
	// write failing every 15s would otherwise bury the logs, and the first
	// occurrence already carries the actionable detail.
	failed bool
}

func newCheckpointStore(path string, logger *slog.Logger) *checkpointStore {
	return &checkpointStore{path: path, logger: logger}
}

func (s *checkpointStore) setSnapshot(fn func() checkpointFile) {
	s.mu.Lock()
	s.snapshot = fn
	s.mu.Unlock()
}

// flush writes the current snapshot. Callers must not hold runnerState.mu or
// FleetCoordinator's locks: the snapshot function takes them itself.
func (s *checkpointStore) flush() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snapshot == nil {
		return
	}
	cp := s.snapshot()
	if err := writeCheckpoint(s.path, cp); err != nil {
		checkpointWriteFailures.Inc()
		if !s.failed {
			s.failed = true
			s.logger.Error("Failed to write control-plane checkpoint; a restart will fall back to Docker-derived adoption",
				slog.String("path", s.path), slog.String("error", err.Error()))
		}
		return
	}
	checkpointLastWriteTimestamp.SetToCurrentTime()
	if s.failed {
		s.failed = false
		s.logger.Info("Control-plane checkpoint writes recovered", slog.String("path", s.path))
	}
}

// writeCheckpoint replaces path atomically. The temp file is created in the
// same directory so the rename never crosses a filesystem boundary, and both
// the file and its directory are fsynced -- a checkpoint that survives the
// process but not the machine would be worse than none, because boot trusts
// it over the Docker-derived fallback.
func writeCheckpoint(path string, cp checkpointFile) error {
	encoded, err := json.Marshal(cp)
	if err != nil {
		return fmt.Errorf("encoding checkpoint: %w", err)
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".checkpoint-*.tmp")
	if err != nil {
		return fmt.Errorf("creating checkpoint temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(encoded); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing checkpoint temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("syncing checkpoint temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing checkpoint temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing checkpoint: %w", err)
	}
	// Best-effort directory fsync: the rename is already atomic, this only
	// guarantees it survives power loss. A filesystem that refuses to open a
	// directory for sync must not fail the write.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// loadCheckpoint reads path. A missing file is not an error -- it is the
// normal first boot -- and returns a nil checkpoint. A corrupt or
// wrong-version file is reported so boot can log it and fall back, rather
// than being silently indistinguishable from a first boot.
func loadCheckpoint(path string) (*checkpointFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading checkpoint: %w", err)
	}
	var cp checkpointFile
	if err := json.Unmarshal(b, &cp); err != nil {
		return nil, fmt.Errorf("decoding checkpoint: %w", err)
	}
	if cp.Version != checkpointVersion {
		return nil, fmt.Errorf("checkpoint version %d is not the supported version %d", cp.Version, checkpointVersion)
	}
	return &cp, nil
}

// runners returns the recorded runners for a scale set, or nil when the
// checkpoint has never seen it (a newly added scale set on an otherwise
// warm restart).
func (c *checkpointFile) runners(scaleSet string) map[string]checkpointRunner {
	if c == nil {
		return nil
	}
	return c.ScaleSets[scaleSet].Runners
}

// validateCheckpointPath checks the shape of a configured state path without
// touching the filesystem, so config parsing stays pure and unit-testable.
// The writability half lives in verifyCheckpointWritable, which startup and
// --check-config both run.
func validateCheckpointPath(path string) error {
	if path == "" {
		return errors.New("server.state_path is required: the control plane checkpoints runner state there so a restart can adopt runners without a full fleet drain")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("server.state_path %q must be an absolute path", path)
	}
	return nil
}

// verifyCheckpointWritable fails fast when the configured state path cannot
// hold a checkpoint. This is deliberately loud: the whole point of requiring
// server.state_path is that a restart is only safe when state actually
// persists, so an unwritable path must stop the process at startup (and at
// --check-config) rather than degrade silently to the Docker-derived guess
// that the checkpoint exists to replace.
func verifyCheckpointWritable(path string) error {
	if err := validateCheckpointPath(path); err != nil {
		return err
	}
	// Reject the path itself being a directory before probing its parent.
	// Probing only the parent would pass here while every atomic rename onto
	// the target failed at runtime -- the mandatory check would report a
	// healthy state path for a deployment that can never checkpoint, which is
	// the exact silent degradation this check exists to prevent. (A likely
	// cause is Docker auto-creating the directory from a volume mount whose
	// target was pointed at the file rather than its parent.)
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return fmt.Errorf("server.state_path %q is a directory; it must be the checkpoint file itself", path)
	}
	dir := filepath.Dir(path)
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("server.state_path directory %q is not usable: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("server.state_path parent %q is not a directory", dir)
	}
	probe, err := os.CreateTemp(dir, ".checkpoint-probe-*")
	if err != nil {
		return fmt.Errorf("server.state_path directory %q is not writable: %w", dir, err)
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return nil
}
