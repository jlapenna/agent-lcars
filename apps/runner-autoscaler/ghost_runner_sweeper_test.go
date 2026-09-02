package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestGitHubRunnerStatusClientListAllRunners(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		w.Header().Set("Content-Type", "application/json")
		switch page {
		case 1:
			_, _ = io.WriteString(w, `{"total_count":101,"runners":[
				{"id":1,"name":"runner-a","status":"offline","busy":false},
				{"id":2,"name":"runner-b","status":"online","busy":true}
			]}`)
		case 2:
			_, _ = io.WriteString(w, `{"total_count":101,"runners":[
				{"id":3,"name":"runner-c","status":"Offline","busy":false}
			]}`)
		default:
			t.Fatalf("unexpected page %d", page)
		}
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	got, err := client.ListAllRunners(context.Background())
	if err != nil {
		t.Fatalf("ListAllRunners: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2 pages", requests)
	}
	want := []ghostRunnerRecord{
		{ID: 1, Name: "runner-a", Status: "offline", Busy: false},
		{ID: 2, Name: "runner-b", Status: "online", Busy: true},
		{ID: 3, Name: "runner-c", Status: "offline", Busy: false},
	}
	if len(got) != len(want) {
		t.Fatalf("ListAllRunners = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("record[%d] = %#v, want %#v (status must be lower-cased)", i, got[i], want[i])
		}
	}
}

func TestGitHubRunnerStatusClientDeleteRunner(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	if err := client.DeleteRunner(context.Background(), 42); err != nil {
		t.Fatalf("DeleteRunner: %v", err)
	}
	if gotMethod != http.MethodDelete {
		t.Fatalf("method = %q, want DELETE", gotMethod)
	}
	if gotPath != "/repos/acme/widgets/actions/runners/42" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
}

func TestGitHubRunnerStatusClientDeleteRunnerFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"Not Found"}`)
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	err := client.DeleteRunner(context.Background(), 42)
	if err == nil {
		t.Fatal("DeleteRunner: want error, got nil")
	}
}

// fakeGhostRunnerSource is the fake Actions API for ghostRunnerSweeper unit
// tests: it never touches the network, and DeleteRunner records what it was
// asked to delete so tests can assert exactly one code path acted.
type fakeGhostRunnerSource struct {
	runners    []ghostRunnerRecord
	listErr    error
	deleteErr  error
	listCalls  int
	deletedIDs []int
}

func (f *fakeGhostRunnerSource) ListAllRunners(context.Context) ([]ghostRunnerRecord, error) {
	f.listCalls++
	return f.runners, f.listErr
}

func (f *fakeGhostRunnerSource) DeleteRunner(_ context.Context, id int) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deletedIDs = append(f.deletedIDs, id)
	return nil
}

func newGhostTestScaler(scaleSet string, idle, busy map[string]runnerRef) *Scaler {
	if idle == nil {
		idle = map[string]runnerRef{}
	}
	if busy == nil {
		busy = map[string]runnerRef{}
	}
	return &Scaler{
		scaleSetName: scaleSet,
		runners:      runnerState{idle: idle, busy: busy},
	}
}

func newGhostTestSweeper(source *fakeGhostRunnerSource, now time.Time, scalers ...*Scaler) *ghostRunnerSweeper {
	return &ghostRunnerSweeper{
		registration: "ghost-sweeper-test-registration",
		source:       source,
		scalers:      scalers,
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}
}

// A ghost must survive at least ghostRunnerMinAge across sweeps before it is
// deleted -- the very first sweep to observe it only starts the clock, so a
// runner mid-flight through startRunner's create/start window is never
// raced.
func TestGhostRunnerSweeperWaitsOutMinAgeBeforeDeleting(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("homelab-ci", nil, nil)
	source := &fakeGhostRunnerSource{runners: []ghostRunnerRecord{
		{ID: 7809, Name: "runner-homelab-ci-268b9908", Status: "offline", Busy: false},
	}}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())
	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted on first observation: %v", source.deletedIDs)
	}
	if got := testutil.ToFloat64(ghostRunnersGauge.WithLabelValues("homelab-ci")); got != 0 {
		t.Fatalf("ghost gauge = %v before min age elapsed, want 0", got)
	}

	sweeper.now = func() time.Time { return start.Add(ghostRunnerMinAge - time.Second) }
	sweeper.sweep(context.Background())
	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted before min age elapsed: %v", source.deletedIDs)
	}

	before := testutil.ToFloat64(ghostRunnersDeletedTotal.WithLabelValues("homelab-ci"))
	sweeper.now = func() time.Time { return start.Add(ghostRunnerMinAge + time.Second) }
	sweeper.sweep(context.Background())
	if len(source.deletedIDs) != 1 || source.deletedIDs[0] != 7809 {
		t.Fatalf("deletedIDs = %v, want [7809]", source.deletedIDs)
	}
	if got := testutil.ToFloat64(ghostRunnersDeletedTotal.WithLabelValues("homelab-ci")); got != before+1 {
		t.Fatalf("deleted total = %v, want %v", got, before+1)
	}
	if got := testutil.ToFloat64(ghostRunnersGauge.WithLabelValues("homelab-ci")); got != 1 {
		t.Fatalf("ghost gauge = %v, want 1", got)
	}
}

func TestGhostRunnerSweeperNeverDeletesBusyRunner(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("busy-lane", nil, nil)
	source := &fakeGhostRunnerSource{runners: []ghostRunnerRecord{
		{ID: 1, Name: "runner-busy-lane-abcd1234", Status: "offline", Busy: true},
	}}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())
	sweeper.now = func() time.Time { return start.Add(time.Hour) }
	sweeper.sweep(context.Background())

	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted a busy runner: %v", source.deletedIDs)
	}
}

func TestGhostRunnerSweeperNeverDeletesTrackedRunner(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("tracked-lane", map[string]runnerRef{
		"runner-tracked-lane-abcd1234": {host: "host-a", startedAt: start},
	}, nil)
	source := &fakeGhostRunnerSource{runners: []ghostRunnerRecord{
		{ID: 1, Name: "runner-tracked-lane-abcd1234", Status: "offline", Busy: false},
	}}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())
	sweeper.now = func() time.Time { return start.Add(time.Hour) }
	sweeper.sweep(context.Background())

	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted a container-backed runner still tracked locally: %v", source.deletedIDs)
	}
}

func TestGhostRunnerSweeperIgnoresOnlineRunner(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("online-lane", nil, nil)
	source := &fakeGhostRunnerSource{runners: []ghostRunnerRecord{
		{ID: 1, Name: "runner-online-lane-abcd1234", Status: "online", Busy: false},
	}}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())
	sweeper.now = func() time.Time { return start.Add(time.Hour) }
	sweeper.sweep(context.Background())

	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted an online runner: %v", source.deletedIDs)
	}
}

// A runner name that does not match any configured scale set's naming
// prefix must never be touched: it might be a manually registered runner,
// or belong to a scale set this process no longer configures.
func TestGhostRunnerSweeperIgnoresUnrelatedName(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("homelab-ci", nil, nil)
	source := &fakeGhostRunnerSource{runners: []ghostRunnerRecord{
		{ID: 1, Name: "some-manually-registered-runner", Status: "offline", Busy: false},
	}}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())
	sweeper.now = func() time.Time { return start.Add(time.Hour) }
	sweeper.sweep(context.Background())

	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted a runner outside this process's naming convention: %v", source.deletedIDs)
	}
}

// The sprinkles anomaly: a registration's REST listing can return zero
// runners while this process is actively tracking some as running. Treating
// that as "zero ghosts" would be technically true but useless; the sweep
// instead skips the pass rather than risk ever silently doing nothing
// forever for a mis-scoped registration.
func TestGhostRunnerSweeperSkipsWhenListingEmptyButRunnersTracked(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("sprinkles-lane", map[string]runnerRef{
		"runner-sprinkles-lane-abcd1234": {host: "host-a", startedAt: start},
	}, nil)
	source := &fakeGhostRunnerSource{runners: nil}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())

	if source.listCalls != 1 {
		t.Fatalf("listCalls = %d, want 1", source.listCalls)
	}
	if len(source.deletedIDs) != 0 {
		t.Fatalf("attempted a delete despite a suspect empty listing: %v", source.deletedIDs)
	}
}

// A runner that goes back online between sweeps must lose its accumulated
// candidate age, the same flap-reset semantics runner_status.go already
// applies to reapUnavailableRunner.
func TestGhostRunnerSweeperResetsCandidateOnRecovery(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("flappy-lane", nil, nil)
	source := &fakeGhostRunnerSource{runners: []ghostRunnerRecord{
		{ID: 1, Name: "runner-flappy-lane-abcd1234", Status: "offline", Busy: false},
	}}
	sweeper := newGhostTestSweeper(source, start, scaler)
	sweeper.sweep(context.Background())

	// Recovers before the age threshold elapses.
	source.runners[0].Status = "online"
	sweeper.now = func() time.Time { return start.Add(ghostRunnerMinAge - time.Second) }
	sweeper.sweep(context.Background())

	// Goes offline again; if the earlier candidacy had survived, this next
	// sweep (only just past the threshold from the ORIGINAL observation)
	// would incorrectly qualify immediately.
	source.runners[0].Status = "offline"
	sweeper.now = func() time.Time { return start.Add(ghostRunnerMinAge + time.Second) }
	sweeper.sweep(context.Background())

	if len(source.deletedIDs) != 0 {
		t.Fatalf("deleted using candidate age accumulated before a recovery: %v", source.deletedIDs)
	}
}

// A failed delete must not lose the accumulated candidate age: the next
// sweep should retry immediately rather than waiting out ghostRunnerMinAge
// a second time.
func TestGhostRunnerSweeperRetriesAfterDeleteFailure(t *testing.T) {
	start := time.Now()
	scaler := newGhostTestScaler("retry-lane", nil, nil)
	source := &fakeGhostRunnerSource{
		runners: []ghostRunnerRecord{
			{ID: 1, Name: "runner-retry-lane-abcd1234", Status: "offline", Busy: false},
		},
		deleteErr: errors.New("temporary GitHub API failure"),
	}
	sweeper := newGhostTestSweeper(source, start, scaler)
	sweeper.sweep(context.Background())

	sweeper.now = func() time.Time { return start.Add(ghostRunnerMinAge + time.Second) }
	sweeper.sweep(context.Background())
	if len(source.deletedIDs) != 0 {
		t.Fatalf("deletedIDs = %v, want none while DeleteRunner is failing", source.deletedIDs)
	}

	source.deleteErr = nil
	sweeper.now = func() time.Time { return start.Add(ghostRunnerMinAge + 2*time.Second) }
	sweeper.sweep(context.Background())
	if len(source.deletedIDs) != 1 || source.deletedIDs[0] != 1 {
		t.Fatalf("deletedIDs = %v, want [1] once DeleteRunner recovers", source.deletedIDs)
	}
}

func TestGhostRunnerSweeperPreservesGaugesOnListError(t *testing.T) {
	start := time.Now()
	scaleSet := "list-error-lane"
	scaler := newGhostTestScaler(scaleSet, nil, nil)
	gauge := ghostRunnersGauge.WithLabelValues(scaleSet)
	gauge.Set(3)
	source := &fakeGhostRunnerSource{listErr: errors.New("unavailable")}
	sweeper := newGhostTestSweeper(source, start, scaler)

	sweeper.sweep(context.Background())

	if got := testutil.ToFloat64(gauge); got != 3 {
		t.Fatalf("ghost gauge changed on a failed listing: %v", got)
	}
}

func TestScalerForGhostNamePicksLongestPrefixMatch(t *testing.T) {
	ci := newGhostTestScaler("ci", nil, nil)
	ciBuild := newGhostTestScaler("ci-build", nil, nil)

	got := scalerForGhostName([]*Scaler{ci, ciBuild}, "runner-ci-build-abcd1234")
	if got != ciBuild {
		t.Fatalf("scalerForGhostName picked the wrong scaler; want the more specific ci-build prefix")
	}

	got = scalerForGhostName([]*Scaler{ci, ciBuild}, "runner-ci-abcd1234")
	if got != ci {
		t.Fatalf("scalerForGhostName picked the wrong scaler for a plain ci-prefixed name")
	}

	if got := scalerForGhostName([]*Scaler{ci, ciBuild}, "runner-unrelated-abcd1234"); got != nil {
		t.Fatalf("scalerForGhostName matched an unrelated name: %v", got)
	}
}

func TestRunnerNamePrefixMatchesStartRunnerConvention(t *testing.T) {
	prefix := runnerNamePrefix("homelab-autoscale/homelab-ci")
	name := fmt.Sprintf("%s%s", prefix, "268b9908")
	if got := dockerSafeNamePart("homelab-autoscale/homelab-ci"); prefix != "runner-"+got+"-" {
		t.Fatalf("runnerNamePrefix = %q, want derived from dockerSafeNamePart(%q) = %q", prefix, "homelab-autoscale/homelab-ci", got)
	}
	if scalerForGhostName([]*Scaler{newGhostTestScaler("homelab-autoscale/homelab-ci", nil, nil)}, name) == nil {
		t.Fatalf("runnerNamePrefix-derived name %q did not match its own scale set", name)
	}
}
