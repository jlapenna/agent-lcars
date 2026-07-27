package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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

	mu              sync.Mutex
	inspect         map[string]inspectStub // containerID -> canned ContainerInspect response
	containers      []container.Summary    // ContainerList response
	removed         []string               // IDs passed to ContainerRemove, in call order
	imagePresent    bool
	imagePulls      int
	pullStreamError bool
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
	f := &fakeDockerServer{inspect: make(map[string]inspectStub)}
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
		f.mu.Unlock()
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
			_, _ = w.Write([]byte("{\"errorDetail\":{\"message\":\"manifest unknown\"},\"error\":\"manifest unknown\"}\n"))
			return
		}
		_, _ = w.Write([]byte("{\"status\":\"Pull complete\"}\n"))

	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeDockerServer) pullCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.imagePulls
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
