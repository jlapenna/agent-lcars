package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
)

// fakeDockerServer is a minimal httptest-based stand-in for a docker
// daemon's HTTP API, covering only what scaler_test.go's
// pruneDeadIdleRunners/cleanupOrphans/pickHost tests exercise: version
// negotiation's lazy /_ping probe, ContainerInspect, ContainerList, and
// ContainerRemove. Shared here (rather than duplicated per test) since
// several TestXxx functions in scaler_test.go need one.
type fakeDockerServer struct {
	srv *httptest.Server

	mu      sync.Mutex
	inspect map[string]inspectStub // containerID -> canned ContainerInspect response
	// inspectCalls records ContainerInspect requests by container ID so tests
	// can prove a listener-path reconciliation did not probe busy runners.
	inspectCalls map[string]int
	// tops: containerID -> canned ContainerTop process list. An ID absent
	// here 404s, which is what cleanupOrphans sees as a top error.
	tops       map[string]container.TopResponse
	containers []container.Summary // ContainerList response
	// memoryTotal is the Docker /info MemTotal value used by reservation-aware
	// placement tests.
	memoryTotal int64
	removed     []string // IDs passed to ContainerRemove, in call order
	// removeForced records whether each ContainerRemove request asked Docker to
	// force deletion. Queue retention must remain false here: a state race
	// should be refused by Docker rather than ending a live direct runner.
	removeForced []bool
	// listDelay stalls every ContainerList response, standing in for a slow
	// fleet host. Lets a test distinguish concurrent from serial fan-out by
	// wall-clock rather than by inspecting goroutines.
	listDelay    time.Duration
	inspectDelay time.Duration
	// removeBlock, when non-nil, makes every ContainerRemove request wait
	// until it is closed (or the request's own context is cancelled, e.g. by
	// the test server shutting down) -- standing in for a host that accepts
	// the connection and then hangs indefinitely, unlike listDelay/
	// inspectDelay's fixed durations. See blockRemoves.
	removeBlock      chan struct{}
	imagePresent     bool
	imagePulls       int
	pullStreamError  bool
	containerCreates int
	createFailures   []int
	// lastCreate captures the most recent /containers/create request body so
	// a test can assert exactly what a caller (e.g. launchDirectRunner) sent
	// -- image, env, labels, bind mounts -- without a real docker daemon.
	lastCreate createdContainerRequest
	// starts counts POST .../containers/{id}/start calls; startFailures pops
	// one status per call (0 means succeed) the same way createFailures does.
	starts        int
	startFailures []int
	waits         int
	waitStatuses  []int
}

// createdContainerRequest mirrors the JSON shape the docker client sends to
// POST /containers/create: container.Config's fields at the top level plus a
// nested "HostConfig". Decoded loosely (only the fields this fixture's
// callers assert on) rather than via the real container.Config/HostConfig
// types, which carry no json tags of their own to lean on.
type createdContainerRequest struct {
	Image      string
	User       string
	Env        []string
	Entrypoint []string
	Cmd        []string
	Labels     map[string]string
	HostConfig struct {
		Binds          []string
		Tmpfs          map[string]string
		NetworkMode    string
		ReadonlyRootfs bool
	}
}

// inspectStub is the canned response for one container ID's ContainerInspect
// call: status 200 with state for a real inspect result, or a non-200 status
// (404 for not-found, anything else e.g. 500 for a generic/transport-ish
// failure) with no state.
type inspectStub struct {
	status int
	state  *container.State
}

// newFakeDockerServer starts the fake server and registers its teardown with
// t.Cleanup.
func newFakeDockerServer(t *testing.T) *fakeDockerServer {
	t.Helper()
	f := &fakeDockerServer{
		inspect: make(map[string]inspectStub), inspectCalls: make(map[string]int), tops: make(map[string]container.TopResponse),
		memoryTotal: 64 * 1024 * 1024 * 1024,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

// client returns a docker client pointed at this fake server with API
// version negotiation enabled -- the fake answers /_ping so negotiation
// succeeds immediately and every subsequent request arrives prefixed with
// e.g. "/v1.47/...".
func (f *fakeDockerServer) client(t *testing.T) *dockerclient.Client {
	t.Helper()
	c, err := dockerclient.NewClientWithOpts(
		dockerclient.WithHost("tcp://"+f.srv.Listener.Addr().String()),
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		t.Fatalf("failed to create fake docker client: %v", err)
	}
	return c
}

// setInspect configures the canned ContainerInspect response for containerID.
// Use http.StatusOK with a state for a real container; http.StatusNotFound
// for a definitive not-found (maps to cerrdefs.IsNotFound via the docker
// client); any other non-200 status (e.g. 500) for a generic/transport-ish
// failure that must NOT be treated as not-found.
func (f *fakeDockerServer) setInspect(containerID string, status int, state *container.State) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inspect[containerID] = inspectStub{status: status, state: state}
}

func (f *fakeDockerServer) inspectCallCount(containerID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.inspectCalls[containerID]
}

// setListDelay makes every ContainerList response stall, standing in for a
// slow fleet host.
func (f *fakeDockerServer) setListDelay(d time.Duration) {
	f.mu.Lock()
	f.listDelay = d
	f.mu.Unlock()
}

func (f *fakeDockerServer) setInspectDelay(d time.Duration) {
	f.mu.Lock()
	f.inspectDelay = d
	f.mu.Unlock()
}

// blockRemoves makes every ContainerRemove request against this fake host
// hang until the returned unblock func is called (register it with
// t.Cleanup so a test that never calls it explicitly still releases any
// still-pending request when the fake server shuts down). Standing in for a
// host that accepts a connection and then never answers -- the scenario
// agent-lcars#1722's immediate drain acknowledgement exists to survive.
func (f *fakeDockerServer) blockRemoves() (unblock func()) {
	f.mu.Lock()
	ch := make(chan struct{})
	f.removeBlock = ch
	f.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(ch) }) }
}

// setContainers configures the full ContainerList response.
func (f *fakeDockerServer) setContainers(cs []container.Summary) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers = cs
}

func (f *fakeDockerServer) setMemoryTotal(bytes int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.memoryTotal = bytes
}

// removedIDs returns the container IDs passed to ContainerRemove so far, in
// call order.
func (f *fakeDockerServer) removedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.removed))
	copy(out, f.removed)
	return out
}

func (f *fakeDockerServer) removalsForced() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]bool, len(f.removeForced))
	copy(out, f.removeForced)
	return out
}

func (f *fakeDockerServer) handle(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/_ping"):
		w.Header().Set("Api-Version", "1.47")
		w.Header().Set("OSType", "linux")
		w.WriteHeader(http.StatusOK)

	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/info"):
		f.mu.Lock()
		memoryTotal := f.memoryTotal
		containers := len(f.containers)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ID": "fake", "Containers": containers, "MemTotal": memoryTotal,
			"DriverStatus": [][2]string{}, "Plugins": map[string]any{},
		})

	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
		f.mu.Lock()
		cs := f.containers
		delay := f.listDelay
		f.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		if cs == nil {
			cs = []container.Summary{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cs)

	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/top"):
		// ContainerTop: GET .../containers/{id}/top. Must be matched before
		// the generic inspect case below, which would otherwise swallow it.
		id := containerIDFromPath(r.URL.Path)
		f.mu.Lock()
		top, ok := f.tops[id]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "No such container: " + id})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(top)

	case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/"):
		// Inspect: GET .../containers/{id}/json
		id := containerIDFromPath(r.URL.Path)
		f.mu.Lock()
		f.inspectCalls[id]++
		stub, ok := f.inspect[id]
		delay := f.inspectDelay
		f.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		if !ok || stub.status == http.StatusNotFound {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "No such container: " + id})
			return
		}
		if stub.status != http.StatusOK {
			w.WriteHeader(stub.status)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "boom"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(container.InspectResponse{
			ContainerJSONBase: &container.ContainerJSONBase{ID: id, State: stub.state},
		})

	case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/containers/"):
		f.mu.Lock()
		block := f.removeBlock
		f.mu.Unlock()
		if block != nil {
			select {
			case <-block:
			case <-r.Context().Done():
				return
			}
		}
		id := containerIDFromPath(r.URL.Path)
		f.mu.Lock()
		f.removed = append(f.removed, id)
		f.removeForced = append(f.removeForced, r.URL.Query().Get("force") == "1" || r.URL.Query().Get("force") == "true")
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)

	case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json"):
		f.mu.Lock()
		present := f.imagePresent
		f.mu.Unlock()
		if !present {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "No such image"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(image.InspectResponse{ID: "sha256:test"})

	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/create"):
		f.mu.Lock()
		f.imagePulls++
		failStream := f.pullStreamError
		if !failStream {
			f.imagePresent = true
		}
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if failStream {
			// A real daemon reports registry/auth/manifest failures INSIDE the
			// progress stream with HTTP 200, not as a transport error.
			_, _ = w.Write([]byte("{\"status\":\"Pulling from library/x\"}\n"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errorDetail": map[string]string{"message": "manifest unknown"},
				"error":       "manifest unknown",
			})
			return
		}
		_, _ = w.Write([]byte("{\"status\":\"Pull complete\"}\n"))

	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/create"):
		var req createdContainerRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.containerCreates++
		f.lastCreate = req
		status := 0
		if len(f.createFailures) > 0 {
			status = f.createFailures[0]
			f.createFailures = f.createFailures[1:]
		}
		if status == http.StatusNotFound {
			// The exact #478 race: a host-side prune removed the image after
			// the caller's successful inspect and before this create.
			f.imagePresent = false
		}
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "No such image"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(container.CreateResponse{ID: "created-container"})

	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/start"):
		f.mu.Lock()
		f.starts++
		status := 0
		if len(f.startFailures) > 0 {
			status = f.startFailures[0]
			f.startFailures = f.startFailures[1:]
		}
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "boom"})
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/wait"):
		f.mu.Lock()
		f.waits++
		status := 0
		if len(f.waitStatuses) > 0 {
			status = f.waitStatuses[0]
			f.waitStatuses = f.waitStatuses[1:]
		}
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(container.WaitResponse{StatusCode: int64(status)})

	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// setTop configures the canned ContainerTop process list for containerID.
// Pass process rows as ContainerTop returns them; a row containing
// "Runner.Worker" is what topHasRunnerWorker looks for.
func (f *fakeDockerServer) setTop(containerID string, processes [][]string) {
	f.mu.Lock()
	f.tops[containerID] = container.TopResponse{Titles: []string{"PID", "CMD"}, Processes: processes}
	f.mu.Unlock()
}

func (f *fakeDockerServer) pullCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.imagePulls
}

func (f *fakeDockerServer) setCreateFailures(statuses ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createFailures = append([]int(nil), statuses...)
}

func (f *fakeDockerServer) createCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.containerCreates
}

// getLastCreate returns the most recently decoded /containers/create body.
func (f *fakeDockerServer) getLastCreate() createdContainerRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastCreate
}

// startCount returns how many POST .../start calls this fixture has seen.
func (f *fakeDockerServer) startCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.starts
}

// setStartFailures queues per-call ContainerStart response statuses (0 means
// succeed), the same way setCreateFailures does for ContainerCreate.
func (f *fakeDockerServer) setStartFailures(statuses ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startFailures = append([]int(nil), statuses...)
}

func (f *fakeDockerServer) waitCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.waits
}

// setWaitStatuses configures the exit status reported by ContainerWait for
// each started test container. A non-zero status models the disposable
// credential probe finding a missing or unreadable bind source.
func (f *fakeDockerServer) setWaitStatuses(statuses ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.waitStatuses = append([]int(nil), statuses...)
}

// containerIDFromPath extracts the {id} segment from versioned docker API
// paths like "/v1.47/containers/{id}/json" or "/v1.47/containers/{id}".
func containerIDFromPath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, part := range parts {
		if part == "containers" && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}
