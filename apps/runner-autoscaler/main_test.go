package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	yaml "go.yaml.in/yaml/v3"
	auth "k8s.io/api/authorization/v1"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
)

func TestCommandFlags(t *testing.T) {
	for _, name := range []string{"config", "check-config"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Errorf("expected --%s flag to be registered", name)
		}
	}
	for _, removed := range []string{"url", "name", "runner-memory", "app-private-key-file"} {
		if cmd.Flags().Lookup(removed) != nil {
			t.Errorf("legacy --%s flag must not remain in queue-executor-only mode", removed)
		}
	}
}

// Exercise the operator's actual --check-config path against an API server:
// permanent deployment failures must surface before the old controller stops,
// and the successful check must not allocate work or change fleet resources.
func TestCheckConfigUsesReadOnlyKubernetesStartupPreflight(t *testing.T) {
	for _, failure := range []string{"", "missing worker", "denied update", "inventory unavailable"} {
		t.Run(failure, func(t *testing.T) {
			seen := map[string]bool{}
			var seenMu sync.Mutex
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				seenMu.Lock()
				seen[r.Method+" "+r.URL.Path] = true
				seenMu.Unlock()
				var response any
				switch r.Method + " " + r.URL.Path {
				case "GET /api/v1/namespaces/lcars-work/secrets/credentials":
					response = &core.Secret{TypeMeta: meta.TypeMeta{APIVersion: "v1", Kind: "Secret"}, Data: map[string][]byte{"telemetry-writer.json": []byte("writer"), "claude-code-oauth-token": []byte("claude"), "opencode-llm-api-key": []byte("opencode")}}
				case "GET /api/v1/namespaces/lcars-work/serviceaccounts/worker":
					if failure == "missing worker" {
						http.Error(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","message":"worker missing","code":404}`, http.StatusNotFound)
						return
					}
					response = &core.ServiceAccount{TypeMeta: meta.TypeMeta{APIVersion: "v1", Kind: "ServiceAccount"}}
				case "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews":
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						return
					}
					decoded, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, nil)
					if err != nil {
						t.Error(err)
						return
					}
					review := decoded.(*auth.SelfSubjectAccessReview)
					response = &auth.SelfSubjectAccessReview{TypeMeta: meta.TypeMeta{APIVersion: "authorization.k8s.io/v1", Kind: "SelfSubjectAccessReview"}, Status: auth.SubjectAccessReviewStatus{Allowed: failure != "denied update" || review.Spec.ResourceAttributes.Verb != "update"}}
				case "GET /apis/batch/v1/namespaces/lcars-work/jobs":
					response = &batch.JobList{TypeMeta: meta.TypeMeta{APIVersion: "batch/v1", Kind: "JobList"}}
				case "GET /api/v1/nodes":
					// A full or tainted fleet is healthy capacity_wait, not a bad
					// deployment: no Ready nodes are required by this check.
					response = &core.NodeList{TypeMeta: meta.TypeMeta{APIVersion: "v1", Kind: "NodeList"}}
				case "GET /api/v1/pods":
					if failure == "inventory unavailable" {
						http.Error(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"ServiceUnavailable","message":"inventory unavailable","code":503}`, http.StatusServiceUnavailable)
						return
					}
					response = &core.PodList{TypeMeta: meta.TypeMeta{APIVersion: "v1", Kind: "PodList"}}
				default:
					t.Errorf("check-config attempted unexpected request %s %s", r.Method, r.URL.Path)
					http.Error(w, "unexpected mutation", http.StatusForbidden)
					return
				}
				if err := json.NewEncoder(w).Encode(response); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			kubeconfig := filepath.Join(t.TempDir(), "kubeconfig")
			body := fmt.Sprintf("apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    server: %s\ncontexts:\n- name: test\n  context: {cluster: test, user: test}\ncurrent-context: test\nusers:\n- name: test\n  user: {token: test}\n", server.URL)
			if err := os.WriteFile(kubeconfig, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			q, _ := kubeQueueFixture()
			q.config.Kubeconfig = kubeconfig
			configBody, err := yaml.Marshal(OrchestratorConfig{Version: 1, Kubernetes: &q.config})
			if err != nil {
				t.Fatal(err)
			}
			oldPath, oldCheck, oldContext := orchestratorConfigPath, checkOrchestratorConfig, cmd.Context()
			t.Cleanup(func() {
				orchestratorConfigPath, checkOrchestratorConfig = oldPath, oldCheck
				cmd.SetContext(oldContext)
			})
			cmd.SetContext(context.Background())
			orchestratorConfigPath, checkOrchestratorConfig = writeConfig(t, string(configBody)), true
			t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "registry.example.com/runner:test")
			t.Setenv("LCARS_CONSOLE_URL", "https://console.example.com")
			t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/controller/writer.json")
			err = cmd.RunE(cmd, nil)
			if (err != nil) != (failure != "") {
				t.Fatalf("check-config error=%v for failure=%q", err, failure)
			}
			if failure == "" {
				seenMu.Lock()
				defer seenMu.Unlock()
				for _, resource := range []string{"GET /api/v1/namespaces/lcars-work/secrets/credentials", "GET /api/v1/namespaces/lcars-work/serviceaccounts/worker", "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews", "GET /apis/batch/v1/namespaces/lcars-work/jobs", "GET /api/v1/nodes", "GET /api/v1/pods"} {
					if !seen[resource] {
						t.Errorf("check-config did not verify %s", resource)
					}
				}
			}
			if err != nil && strings.Contains(err.Error(), "opencode") {
				t.Fatalf("preflight failure exposed a credential value: %v", err)
			}
		})
	}
}
