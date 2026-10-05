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
// daemon's HTTP API, covering what the queue executor's direct-runner tests
// exercise: version negotiation's lazy /_ping probe, ContainerInspect,
// ContainerList, ContainerCreate/Start/Wait/Remove, and image inspect/pull.
// Shared here (rather than duplicated per test) since several TestXxx
// functions need one.
type fakeDockerServer struct {
	srv *httptest.Server

	mu      sync.Mutex
	inspect map[string]inspectStub // containerID -> canned ContainerInspect response

	containers []container.Summary // ContainerList response
	removed    []string            // IDs passed to ContainerRemove, in call order
	// removeForced records whether each ContainerRemove request asked Docker to
	// force deletion. Queue retention must remain false here: a state race
	// should be refused by Docker rather than ending a live direct runner.
	removeForced []bool
	inspectDelay time.Duration

	imagePresent    bool
	imagePulls      int
	pullStreamError bool
	// localDigest is the cached image's repo digest and registryDigest the
	// tag's current registry digest. An empty registryDigest makes the
	// distribution lookup fail, the way an unreachable registry does; a
	// successful pull adopts registryDigest as the cached digest.
	localDigest      string
	registryDigest   string
	digestLookups    int
	containerCreates int
	// lastCreate captures the most recent /containers/create request body so
	// a test can assert exactly what a caller (e.g. launchDirectRunner) sent
	// -- image, env, labels, bind mounts -- without a real docker daemon.
	lastCreate createdContainerRequest
	// starts counts POST .../containers/{id}/start calls; startFailures pops
	// one status per call (0 means succeed) the same way the create-failure
	// path does.
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
		inspect: make(map[string]inspectStub),
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

func (f *fakeDockerServer) setInspectDelay(d time.Duration) {
	f.mu.Lock()
	f.inspectDelay = d
	f.mu.Unlock()
}

// setContainers configures the full ContainerList response.
func (f *fakeDockerServer) setContainers(cs []container.Summary) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers = cs
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

	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
		f.mu.Lock()
		cs := f.containers
		f.mu.Unlock()
		if cs == nil {
			cs = []container.Summary{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cs)

	case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/"):
		// Inspect: GET .../containers/{id}/json
		id := containerIDFromPath(r.URL.Path)
		f.mu.Lock()
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
		f.mu.Lock()
		var repoDigests []string
		if f.localDigest != "" {
			repoDigests = []string{"registry/direct-runner@" + f.localDigest}
		}
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(image.InspectResponse{ID: "sha256:test", RepoDigests: repoDigests})

	case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/distribution/"):
		f.mu.Lock()
		f.digestLookups++
		remote := f.registryDigest
		f.mu.Unlock()
		if remote == "" {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "registry unreachable"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"Descriptor": map[string]any{
			"mediaType": "application/vnd.oci.image.index.v1+json", "digest": remote, "size": 1,
		}})

	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/create"):
		f.mu.Lock()
		f.imagePulls++
		failStream := f.pullStreamError
		if !failStream {
			f.imagePresent = true
			f.localDigest = f.registryDigest
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
		f.mu.Unlock()
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

func (f *fakeDockerServer) pullCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.imagePulls
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
// succeed).
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
