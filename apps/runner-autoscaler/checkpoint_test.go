package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
)

func testCheckpoint() checkpointFile {
	return checkpointFile{
		Version:   checkpointVersion,
		WrittenAt: time.Unix(1785702249, 0).UTC(),
		ScaleSets: map[string]checkpointScaleSet{
			"default": {
				Runners: map[string]checkpointRunner{
					"runner-default-aaaa": {Host: "janeway", ContainerID: "a", StartedAt: time.Unix(1785702000, 0).UTC(), Busy: true},
					"runner-default-bbbb": {Host: "pike", ContainerID: "b", StartedAt: time.Unix(1785702100, 0).UTC()},
				},
			},
		},
		Fleet: checkpointFleet{
			OverloadedUntil: map[string]time.Time{"spark": time.Unix(1785702300, 0).UTC()},
			HostSamples: map[string]checkpointHostSample{
				"pike": {At: time.Unix(1785702240, 0).UTC(), IdleSeconds: 1234.5, CPUPressure: 0.2, MemoryPressure: 0.1, SwapPages: 7},
			},
		},
	}
}

func TestCheckpointRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	want := testCheckpoint()
	if err := writeCheckpoint(path, want); err != nil {
		t.Fatalf("writeCheckpoint: %v", err)
	}
	got, err := loadCheckpoint(path)
	if err != nil {
		t.Fatalf("loadCheckpoint: %v", err)
	}
	if got == nil {
		t.Fatal("expected a checkpoint, got nil")
	}
	runner, ok := got.runners("default")["runner-default-aaaa"]
	if !ok {
		t.Fatal("expected runner-default-aaaa in the default scale set")
	}
	if !runner.Busy || runner.Host != "janeway" || runner.ContainerID != "a" {
		t.Fatalf("busy runner did not round-trip: %+v", runner)
	}
	if idle := got.runners("default")["runner-default-bbbb"]; idle.Busy {
		t.Fatal("idle runner round-tripped as busy")
	}
	if !runner.StartedAt.Equal(time.Unix(1785702000, 0)) {
		t.Fatalf("startedAt did not round-trip: %v", runner.StartedAt)
	}
}

// A missing file is the normal first boot, not an error: the process must
// start and fall back to Docker-derived adoption rather than refusing to run.
func TestLoadCheckpointMissingFileIsNotAnError(t *testing.T) {
	got, err := loadCheckpoint(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("expected no error for a missing checkpoint, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil checkpoint, got %+v", got)
	}
}

// A corrupt or future-versioned file must be reported rather than silently
// treated as a first boot -- boot logs it and falls back, but the operator
// needs to be able to tell the two apart.
func TestLoadCheckpointRejectsCorruptAndWrongVersion(t *testing.T) {
	dir := t.TempDir()

	corrupt := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(corrupt, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCheckpoint(corrupt); err == nil {
		t.Fatal("expected an error for a corrupt checkpoint")
	}

	future := testCheckpoint()
	future.Version = checkpointVersion + 1
	encoded, err := json.Marshal(future)
	if err != nil {
		t.Fatal(err)
	}
	versioned := filepath.Join(dir, "future.json")
	if err := os.WriteFile(versioned, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCheckpoint(versioned); err == nil {
		t.Fatal("expected an error for an unsupported checkpoint version")
	}
}

// The write must replace the previous checkpoint atomically and leave no
// temp files behind: a half-written checkpoint read at boot would be worse
// than none, because adoption trusts it over the Docker-derived fallback.
func TestWriteCheckpointReplacesAtomicallyAndCleansUp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	first := testCheckpoint()
	if err := writeCheckpoint(path, first); err != nil {
		t.Fatal(err)
	}
	second := testCheckpoint()
	second.ScaleSets = map[string]checkpointScaleSet{"default": {Runners: map[string]checkpointRunner{}}}
	if err := writeCheckpoint(path, second); err != nil {
		t.Fatal(err)
	}

	got, err := loadCheckpoint(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.runners("default")) != 0 {
		t.Fatalf("expected the second write to replace the first, got %+v", got.runners("default"))
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected only the checkpoint to remain, got %d entries", len(entries))
	}
}

func TestValidateCheckpointPath(t *testing.T) {
	if err := validateCheckpointPath(""); err == nil {
		t.Fatal("expected an empty state_path to be rejected")
	}
	if err := validateCheckpointPath("relative/state.json"); err == nil {
		t.Fatal("expected a relative state_path to be rejected")
	}
	if err := validateCheckpointPath("/var/lib/runner-autoscaler/state.json"); err != nil {
		t.Fatalf("expected an absolute path to be accepted, got %v", err)
	}
}

// The whole point of requiring server.state_path is that a restart is only
// safe when state actually persists, so an unwritable path must fail loudly
// at startup and --check-config rather than degrade to the guess.
func TestVerifyCheckpointWritableRejectsMissingDirectory(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope", "state.json")
	if err := verifyCheckpointWritable(missing); err == nil {
		t.Fatal("expected a missing state directory to be rejected")
	}
	ok := filepath.Join(t.TempDir(), "state.json")
	if err := verifyCheckpointWritable(ok); err != nil {
		t.Fatalf("expected a writable directory to be accepted, got %v", err)
	}
}

// Probing only the parent would pass while every atomic rename onto the
// target failed, reporting a healthy state path for a deployment that can
// never checkpoint -- the silent degradation the mandatory check exists to
// prevent. A plausible cause is a volume mount aimed at the file rather than
// its parent, which Docker then auto-creates as a directory.
func TestVerifyCheckpointWritableRejectsDirectoryAtPath(t *testing.T) {
	dir := t.TempDir()
	asDir := filepath.Join(dir, "state.json")
	if err := os.Mkdir(asDir, 0o755); err != nil {
		t.Fatal(err)
	}
	err := verifyCheckpointWritable(asDir)
	if err == nil {
		t.Fatal("expected a directory at state_path to be rejected")
	}
	if !strings.Contains(err.Error(), "is a directory") {
		t.Fatalf("error should name the cause, got %v", err)
	}
}

// A nil store must be a no-op rather than a panic: tests and the
// single-scaler construction paths build Scalers without one.
func TestNilCheckpointStoreFlushIsNoOp(t *testing.T) {
	var store *checkpointStore
	store.flush()
}

func TestFleetCoordinatorRestoreDropsExpiredCooldowns(t *testing.T) {
	now := time.Unix(1785702300, 0).UTC()
	fleet := newFleetCoordinator(0, nil, nil, nil, nil, nil)
	fleet.restore(checkpointFleet{
		OverloadedUntil: map[string]time.Time{
			"spark": now.Add(time.Minute),
			"pike":  now.Add(-time.Minute),
		},
		HostSamples: map[string]checkpointHostSample{
			"pike": {At: now.Add(-15 * time.Second), IdleSeconds: 99, CPUPressure: 0.5},
		},
	}, now)

	fleet.overloadMu.Lock()
	_, sparkHeld := fleet.overloadedUntil["spark"]
	_, pikeHeld := fleet.overloadedUntil["pike"]
	fleet.overloadMu.Unlock()
	if !sparkHeld {
		t.Error("expected an unexpired cooldown to be restored")
	}
	if pikeHeld {
		t.Error("expected an already-expired cooldown to be dropped rather than restored")
	}

	// Samples must come back so the first post-boot probe computes a real
	// rate instead of a zero one, which would silently disable
	// pressure-based admission until a second sample landed.
	fleet.hostSampleMu.Lock()
	sample, ok := fleet.hostSamples["pike"]
	fleet.hostSampleMu.Unlock()
	if !ok || sample.idleSeconds != 99 || sample.cpuPressure != 0.5 {
		t.Fatalf("host sample did not restore: %+v (present=%v)", sample, ok)
	}
}

func TestSnapshotRunnersRecordsIdleBusySplit(t *testing.T) {
	scaler := &Scaler{
		scaleSetName: "default",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
	}
	scaler.runners.addIdle("idle-runner", "pike", "c1", time.Unix(1785702000, 0))
	scaler.runners.addIdle("busy-runner", "janeway", "c2", time.Unix(1785702100, 0))
	if !scaler.runners.markBusy("busy-runner") {
		t.Fatal("expected markBusy to succeed")
	}

	got := scaler.snapshotRunners()
	if got.Draining {
		t.Error("expected draining to be false")
	}
	if len(got.Runners) != 2 {
		t.Fatalf("expected 2 runners, got %d", len(got.Runners))
	}
	if got.Runners["idle-runner"].Busy {
		t.Error("idle runner recorded as busy")
	}
	if !got.Runners["busy-runner"].Busy {
		t.Error("busy runner recorded as idle")
	}
	if got.Runners["busy-runner"].Host != "janeway" {
		t.Errorf("busy runner host = %q, want janeway", got.Runners["busy-runner"].Host)
	}
}

// The case the whole change exists for: a runner GitHub has already assigned
// a job to, still early enough in its startup that no Runner.Worker process
// exists yet. The ContainerTop probe calls that idle, and anything reaping
// idle capacity then kills a live job -- which is why a restart previously
// had to be preceded by a full fleet drain. With a checkpoint, the control
// plane restores what it actually knew.
func TestBootAdoptionPrefersCheckpointOverProcessProbe(t *testing.T) {
	old := time.Now().Add(-time.Hour).Unix()
	ours := map[string]string{runnerScaleSetLabelKey: "myset"}

	f := newFakeDockerServer(t)
	f.setContainers([]container.Summary{
		{ID: "assigned", Names: []string{"/runner-assigned"}, Labels: ours, State: container.StateRunning, Created: old},
		{ID: "genuinely-idle", Names: []string{"/runner-genuinely-idle"}, Labels: ours, State: container.StateRunning, Created: old},
	})
	// Both look identical to the probe: running, no Runner.Worker yet.
	f.setTop("assigned", [][]string{{"1", "/home/runner/run.sh"}})
	f.setTop("genuinely-idle", [][]string{{"1", "/home/runner/run.sh"}})

	scaler := &Scaler{
		scaleSetName:   "myset",
		dockerHosts:    []DockerHost{{Name: "host-a", Client: f.client(t)}},
		runners:        runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		bootCheckpoint: map[string]checkpointRunner{
			"runner-assigned": {Host: "host-a", ContainerID: "assigned", Busy: true},
		},
	}

	scaler.cleanupOrphans(context.Background(), true)

	if _, ok := scaler.runners.busy["runner-assigned"]; !ok {
		t.Errorf("checkpointed busy runner was not adopted as busy: idle=%#v busy=%#v", scaler.runners.idle, scaler.runners.busy)
	}
	// Not in the checkpoint, and the probe says no worker: still idle.
	if _, ok := scaler.runners.idle["runner-genuinely-idle"]; !ok {
		t.Errorf("uncheckpointed runner should fall back to the probe and adopt as idle: idle=%#v busy=%#v", scaler.runners.idle, scaler.runners.busy)
	}
	for _, id := range f.removedIDs() {
		t.Errorf("boot adoption must not remove running containers, removed %q", id)
	}
}

// quiesce must preserve idle runners. Destroying them was pure loss once
// adoption became reliable: they are warm, already-registered capacity the
// replacement process picks up immediately.
func TestQuiescePreservesIdleRunnersAndCheckpoints(t *testing.T) {
	f := newFakeDockerServer(t)
	path := filepath.Join(t.TempDir(), "state.json")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := newCheckpointStore(path, logger)

	scaler := &Scaler{
		scaleSetName:   "myset",
		dockerHosts:    []DockerHost{{Name: "host-a", Client: f.client(t)}},
		runners:        runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		scalesetClient: newStubScalesetClient(t),
		logger:         logger,
		checkpoints:    store,
	}
	scaler.runners.addIdle("runner-idle", "host-a", "i1", time.Unix(1785702000, 0))
	scaler.runners.addIdle("runner-busy", "host-a", "b1", time.Unix(1785702000, 0))
	scaler.runners.markBusy("runner-busy")

	runtimes := []*scaleSetRuntime{{config: Config{ScaleSetName: "myset"}, scaler: scaler}}
	fleet := newFleetCoordinator(0, nil, nil, nil, nil, nil)
	store.setSnapshot(orchestratorSnapshot(runtimes, fleet))

	done := make(chan struct{})
	close(done)
	quiesce(context.Background(), runtimeGeneration{cancel: func() {}, done: done}, runtimes, store, logger)

	for _, id := range f.removedIDs() {
		t.Errorf("quiesce must not remove any runner container, removed %q", id)
	}
	if !scaler.quiescing.Load() {
		t.Error("quiesce should stop further placements")
	}

	cp, err := loadCheckpoint(path)
	if err != nil {
		t.Fatalf("quiesce did not leave a readable checkpoint: %v", err)
	}
	runners := cp.runners("myset")
	if len(runners) != 2 {
		t.Fatalf("expected both runners checkpointed, got %#v", runners)
	}
	if runners["runner-idle"].Busy {
		t.Error("idle runner checkpointed as busy")
	}
	if !runners["runner-busy"].Busy {
		t.Error("busy runner checkpointed as idle")
	}
}

// quiesce must not hang on a generation that refuses to stop: overrunning
// Docker's stop grace turns an orderly exit into a SIGKILL, discarding the
// checkpoint this path exists to write.
func TestQuiesceCheckpointsEvenIfGenerationHangs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := newCheckpointStore(path, logger)
	scaler := &Scaler{
		scaleSetName: "myset",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       logger,
		checkpoints:  store,
	}
	scaler.runners.addIdle("runner-idle", "host-a", "i1", time.Unix(1785702000, 0))
	runtimes := []*scaleSetRuntime{{config: Config{ScaleSetName: "myset"}, scaler: scaler}}
	store.setSnapshot(orchestratorSnapshot(runtimes, newFleetCoordinator(0, nil, nil, nil, nil, nil)))

	start := time.Now()
	// A done channel that never closes, standing in for a listener wedged on
	// a black-holed connection.
	quiesce(context.Background(), runtimeGeneration{cancel: func() {}, done: make(chan struct{})}, runtimes, store, logger)
	elapsed := time.Since(start)

	if elapsed > quiesceTimeout+2*time.Second {
		t.Errorf("quiesce took %v, expected to give up near %v", elapsed, quiesceTimeout)
	}
	if _, err := loadCheckpoint(path); err != nil {
		t.Fatalf("expected a checkpoint despite the hung generation: %v", err)
	}
}

// agent-lcars#511: the boot sweep used to run hosts serially, so one wedged
// fleet host stalled every host after it -- and since each scale set runs its
// own boot sweep before its listener connects, every scale set paid that
// stall independently. Wall-clock is the honest assertion here: with N slow
// hosts, serial costs N*delay and concurrent costs ~delay.
func TestCleanupOrphansSweepsHostsConcurrently(t *testing.T) {
	const delay = 400 * time.Millisecond
	const hosts = 4

	scaler := &Scaler{
		scaleSetName:   "myset",
		runners:        runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for i := range hosts {
		f := newFakeDockerServer(t)
		f.setListDelay(delay)
		scaler.dockerHosts = append(scaler.dockerHosts, DockerHost{
			Name: fmt.Sprintf("host-%d", i), Client: f.client(t),
		})
	}

	start := time.Now()
	scaler.cleanupOrphans(context.Background(), true)
	elapsed := time.Since(start)

	if serial := hosts * delay; elapsed >= serial {
		t.Fatalf("sweep took %v, at least the serial cost %v -- hosts are not being swept concurrently", elapsed, serial)
	}
}

// An unreachable host must be skipped rather than blocking the sweep, and
// must not stop the reachable hosts from being swept. Skipping is already the
// behavior when the list call itself errors; the ping gate just reaches that
// outcome without waiting out a transport timeout first.
func TestCleanupOrphansSkipsUnreachableHostAndSweepsTheRest(t *testing.T) {
	old := time.Now().Add(-time.Hour).Unix()
	ours := map[string]string{runnerScaleSetLabelKey: "myset"}

	healthy := newFakeDockerServer(t)
	healthy.setContainers([]container.Summary{
		{ID: "dead", Names: []string{"/runner-dead"}, Labels: ours, State: container.StateExited, Created: old},
	})

	// Port 1 refuses immediately: an unreachable host without making the
	// test wait on a real transport timeout.
	unreachable, err := dockerclient.NewClientWithOpts(
		dockerclient.WithHost("tcp://127.0.0.1:1"),
	)
	if err != nil {
		t.Fatal(err)
	}

	scaler := &Scaler{
		scaleSetName: "myset",
		dockerHosts: []DockerHost{
			{Name: "unreachable", Client: unreachable},
			{Name: "healthy", Client: healthy.client(t)},
		},
		runners:        runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	scaler.cleanupOrphans(context.Background(), true)

	removed := healthy.removedIDs()
	if len(removed) != 1 || removed[0] != "dead" {
		t.Fatalf("healthy host should still have been swept despite an unreachable peer, removed=%v", removed)
	}
}
