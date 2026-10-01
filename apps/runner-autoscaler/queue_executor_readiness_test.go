package main

import (
	"context"
	"errors"
	"testing"

	dockerclient "github.com/docker/docker/client"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// TestDirectRunnerCapacityReservationsSkipsUnreadyHostAndChoosesNext proves
// reserve() treats a failed or zero-valued readiness probe as "skip this
// host for this launch", the same way it already treats a full host --
// never as an inventory fault -- and moves on to the next configured host in
// round-robin order.
func TestDirectRunnerCapacityReservationsSkipsUnreadyHostAndChoosesNext(t *testing.T) {
	unready := newFakeDockerServer(t)
	spare := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) {
		switch target {
		case "fake-target-unready":
			return unready.client(t), nil
		case "fake-target-spare":
			return spare.client(t), nil
		default:
			t.Fatalf("unexpected docker target %q", target)
			return nil, nil
		}
	}

	resolved := testQueueResolved(t, resolvedOrchestratorConfig{
		DockerHosts: []string{"readiness-unready-a=fake-target-unready", "readiness-unready-b=fake-target-spare"},
		Readiness: map[string]hostReadinessConfig{
			"readiness-unready-a": {url: "http://unused.invalid/metrics", metric: "host_ready"},
		},
	})
	reservations := newDirectRunnerCapacityReservations(resolved, newClient, discardLogger())
	reservations.checkReadiness = func(ctx context.Context, cfg hostReadinessConfig) (bool, error) {
		if cfg.url == "http://unused.invalid/metrics" {
			return false, nil
		}
		return true, nil
	}

	before := testutil.ToFloat64(queueExecutorHostUnreadyTotal.WithLabelValues("readiness-unready-a"))
	reservation, err := reservations.reserve(context.Background())
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if reservation == nil {
		t.Fatal("reserve returned no reservation, want the spare host's capacity")
	}
	defer reservation.release()
	if got := testutil.ToFloat64(queueExecutorHostUnreadyTotal.WithLabelValues("readiness-unready-a")); got != before+1 {
		t.Fatalf("host_unready_total{host=%q} = %v, want %v", "readiness-unready-a", got, before+1)
	}
	if unready.createCount() != 0 {
		t.Fatalf("unready host received a Docker connection/create, want none: createCount=%d", unready.createCount())
	}

	if err := reservation.launch(directRunnerLaunch{runID: "work:01READINESSSKIP/r1", runToken: "t", pipeline: "codex"}); err != nil {
		t.Fatalf("reservation.launch: %v", err)
	}
	if spare.createCount() != 1 {
		t.Fatalf("spare host createCount = %d, want 1", spare.createCount())
	}
	if unready.createCount() != 0 {
		t.Fatalf("unready host createCount = %d, want 0", unready.createCount())
	}
}

// TestDirectRunnerCapacityReservationsReadinessFetchErrorSkipsHost proves a
// readiness-fetch error (HTTP error, timeout, malformed body) is treated
// exactly like a 0 value -- the host is skipped, not treated as an inventory
// fault that fails the whole reserve() call.
func TestDirectRunnerCapacityReservationsReadinessFetchErrorSkipsHost(t *testing.T) {
	spare := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return spare.client(t), nil }

	resolved := testQueueResolved(t, resolvedOrchestratorConfig{
		DockerHosts: []string{"readiness-error-a=fake-target-a", "readiness-error-b=fake-target-b"},
		Readiness: map[string]hostReadinessConfig{
			"readiness-error-a": {url: "http://unused.invalid/metrics", metric: "host_ready"},
		},
	})
	reservations := newDirectRunnerCapacityReservations(resolved, newClient, discardLogger())
	reservations.checkReadiness = func(ctx context.Context, cfg hostReadinessConfig) (bool, error) {
		return false, errors.New("readiness endpoint unreachable")
	}

	reservation, err := reservations.reserve(context.Background())
	if err != nil {
		t.Fatalf("reserve returned an error for a readiness fetch failure, want a skip: %v", err)
	}
	if reservation == nil {
		t.Fatal("reserve returned no reservation, want the ungated host's capacity")
	}
	reservation.release()
}

// TestDirectRunnerCapacityReservationsAllHostsUnreadyMeansNoLaunch proves
// that when every configured host fails its readiness gate, reserve()
// reports exactly the same "no capacity available" outcome (nil, nil) as an
// entirely full fleet -- the claim is left queued, never launched -- rather
// than returning an error.
func TestDirectRunnerCapacityReservationsAllHostsUnreadyMeansNoLaunch(t *testing.T) {
	connections := 0
	newClient := func(target string) (*dockerclient.Client, error) {
		connections++
		return newFakeDockerServer(t).client(t), nil
	}

	resolved := testQueueResolved(t, resolvedOrchestratorConfig{
		DockerHosts: []string{"readiness-allunready-a=fake-target-a", "readiness-allunready-b=fake-target-b"},
		Readiness: map[string]hostReadinessConfig{
			"readiness-allunready-a": {url: "http://a.invalid/metrics", metric: "host_ready"},
			"readiness-allunready-b": {url: "http://b.invalid/metrics", metric: "host_ready"},
		},
	})
	reservations := newDirectRunnerCapacityReservations(resolved, newClient, discardLogger())
	reservations.checkReadiness = func(ctx context.Context, cfg hostReadinessConfig) (bool, error) { return false, nil }

	reservation, err := reservations.reserve(context.Background())
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if reservation != nil {
		t.Fatalf("reserve returned a reservation with every host unready")
	}
	if connections != 0 {
		t.Fatalf("an all-unready reserve connected to Docker %d times, want 0 (readiness is checked first)", connections)
	}
}

// TestDirectRunnerCapacityReservationsHostWithoutReadinessURLAlwaysEligible
// proves a host absent from Readiness keeps today's behavior exactly:
// eligible unconditionally, with checkReadiness never consulted for it.
func TestDirectRunnerCapacityReservationsHostWithoutReadinessURLAlwaysEligible(t *testing.T) {
	docker := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return docker.client(t), nil }

	resolved := testQueueResolved(t, resolvedOrchestratorConfig{
		DockerHosts: []string{"readiness-none-a=fake-target-a"},
	})
	reservations := newDirectRunnerCapacityReservations(resolved, newClient, discardLogger())
	reservations.checkReadiness = func(ctx context.Context, cfg hostReadinessConfig) (bool, error) {
		t.Fatal("checkReadiness must not be called for a host with no readiness_url")
		return false, nil
	}

	reservation, err := reservations.reserve(context.Background())
	if err != nil || reservation == nil {
		t.Fatalf("reserve = (%v, %v), want a reservation for an ungated host", reservation, err)
	}
	reservation.release()
}
