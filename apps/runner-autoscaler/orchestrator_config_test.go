package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validOrchestratorYAML = `
version: 1
github:
  url: https://github.com/example/repo
server: {}
fleet:
  max_runners: 2
  hosts:
    - name: janeway
      docker: local
      runner_limit: 1
      workdir_size_cap: 30g
      docker_socket_gid: "108"
  placement: {}
scale_sets:
  - name: default
    labels: [default]
    runner_image: example/default:latest
    min_runners: 0
    max_runners: 1
  - name: e2e
    labels: [e2e]
    runner_image: example/e2e:latest
    min_runners: 0
    max_runners: 1
    mount_docker_socket: true
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "orchestrator.yml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadOrchestratorConfig(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.RunnerLimits["janeway"]; got != 1 {
		t.Fatalf("runner limit = %d, want 1", got)
	}
	if got := resolved.DockerSocketGID["janeway"]; got != "108" {
		t.Fatalf("socket gid = %q, want 108", got)
	}
	if len(resolved.ScaleSets) != 2 || resolved.Weights["default"] != 1 {
		t.Fatalf("unexpected resolved scale sets: %#v", resolved.ScaleSets)
	}
}

func TestOrchestratorConfigRejectsUnknownField(t *testing.T) {
	_, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML+"unknown: true\n"))
	if err == nil || !strings.Contains(err.Error(), "field unknown not found") {
		t.Fatalf("expected strict YAML error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsDuplicateLabel(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "labels: [e2e]", "labels: [default]", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "label \"default\" is shared") {
		t.Fatalf("expected duplicate-label error, got %v", err)
	}
}

func TestOrchestratorConfigRequiresSocketHostPolicy(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      docker_socket_gid: \"108\"\n", "", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "requires docker_socket_gid") {
		t.Fatalf("expected missing socket GID error, got %v", err)
	}
}

func TestOrchestratorConfigDefaultsMetricsAddrToLocalhost(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.Raw.Server.MetricsAddr; got != "127.0.0.1:8080" {
		t.Fatalf("metrics addr = %q, want 127.0.0.1:8080 (localhost-only default)", got)
	}
}

func TestOrchestratorConfigDockerSocketAllowlistRejectsUnlisted(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}\n", "  placement: {}\n  docker_socket_allowlist: [default]\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "not in fleet.docker_socket_allowlist") {
		t.Fatalf("expected docker_socket_allowlist rejection, got %v", err)
	}
}

func TestOrchestratorConfigDockerSocketAllowlistAllowsListed(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}\n", "  placement: {}\n  docker_socket_allowlist: [e2e]\n", 1)
	if _, err := loadOrchestratorConfig(writeConfig(t, body)); err != nil {
		t.Fatalf("expected e2e to pass the allowlist, got %v", err)
	}
}

func TestLoadCredentials(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "app.pem")
	if err := os.WriteFile(keyPath, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_CLIENT_ID", "client")
	t.Setenv("APP_INSTALLATION_ID", "42")
	t.Setenv("APP_PRIVATE_KEY_FILE", keyPath)
	if err := resolved.loadCredentials(); err != nil {
		t.Fatal(err)
	}
	for _, c := range resolved.ScaleSets {
		if c.GitHubApp.ClientID != "client" || c.GitHubApp.InstallationID != 42 || c.GitHubApp.PrivateKey != "key" {
			t.Fatalf("credentials not propagated to %q", c.ScaleSetName)
		}
		if c.RegistrationName != primaryRegistrationName {
			t.Fatalf("scale set %q registration = %q, want %q", c.ScaleSetName, c.RegistrationName, primaryRegistrationName)
		}
	}
}

// registrationYAML appends an additional homelab#97 registration, reusing
// the label "default" (allowed: label uniqueness is scoped per registration,
// matching GitHub's own per-account constraint) but a distinct scale-set
// name (required: names stay process-wide unique across every registration).
func registrationYAML(extra string) string {
	return validOrchestratorYAML + `registrations:
  - name: second
    github:
      url: https://github.com/example/other-repo
    app:
      client_id: second-client
      installation_id: 99
      private_key_file: ` + extra + `
    scale_sets:
      - name: second-default
        labels: [default]
        runner_image: example/second:latest
        min_runners: 0
        max_runners: 1
`
}

func TestLoadOrchestratorConfigWithAdditionalRegistration(t *testing.T) {
	keyPath := filepath.Join(t.TempDir(), "second-app.pem")
	if err := os.WriteFile(keyPath, []byte("second-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	// fleet.max_runners must not exceed the aggregate across BOTH the
	// primary scale sets (2) and the new registration's (1).
	body := strings.Replace(registrationYAML(keyPath), "max_runners: 2\n", "max_runners: 3\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.ScaleSets) != 3 {
		t.Fatalf("resolved scale sets = %d, want 3: %#v", len(resolved.ScaleSets), resolved.ScaleSets)
	}
	var second Config
	found := false
	for _, c := range resolved.ScaleSets {
		if c.ScaleSetName == "second-default" {
			second, found = c, true
		}
	}
	if !found {
		t.Fatalf("second registration's scale set not resolved: %#v", resolved.ScaleSets)
	}
	if second.RegistrationName != "second" || second.RegistrationURL != "https://github.com/example/other-repo" {
		t.Fatalf("second scale set registration wiring wrong: %#v", second)
	}

	// The primary registration's scale sets must NOT pick up "second"'s
	// credentials (or vice versa) -- each registration's App auth stays
	// scoped to its own scale sets despite sharing one []Config slice.
	t.Setenv("APP_CLIENT_ID", "primary-client")
	t.Setenv("APP_INSTALLATION_ID", "42")
	primaryKeyPath := filepath.Join(t.TempDir(), "primary-app.pem")
	if err := os.WriteFile(primaryKeyPath, []byte("primary-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_PRIVATE_KEY_FILE", primaryKeyPath)
	resolved, err = loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if err := resolved.loadCredentials(); err != nil {
		t.Fatal(err)
	}
	for _, c := range resolved.ScaleSets {
		switch c.RegistrationName {
		case primaryRegistrationName:
			if c.GitHubApp.ClientID != "primary-client" || c.GitHubApp.PrivateKey != "primary-key" {
				t.Fatalf("primary scale set %q got wrong credentials: %#v", c.ScaleSetName, c.GitHubApp)
			}
		case "second":
			if c.GitHubApp.ClientID != "second-client" || c.GitHubApp.InstallationID != 99 || c.GitHubApp.PrivateKey != "second-key" {
				t.Fatalf("registration \"second\" scale set %q got wrong credentials: %#v", c.ScaleSetName, c.GitHubApp)
			}
		default:
			t.Fatalf("unexpected registration name %q", c.RegistrationName)
		}
	}
}

func TestOrchestratorConfigRejectsDuplicateRegistrationName(t *testing.T) {
	// Append a SECOND "registrations:" list entry also named "second" --
	// still valid YAML (two items in one list), but resolve() must reject
	// the name collision.
	body := registrationYAML("/secrets/second.pem") + `  - name: second
    github:
      url: https://github.com/example/third-repo
    app:
      client_id: third-client
      installation_id: 100
      private_key_file: /secrets/third.pem
    scale_sets:
      - name: third-default
        labels: [third]
        runner_image: example/third:latest
        min_runners: 0
        max_runners: 1
`
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), `duplicate registration name "second"`) {
		t.Fatalf("expected duplicate registration name error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsReservedRegistrationName(t *testing.T) {
	body := strings.Replace(registrationYAML("/secrets/second.pem"), "name: second\n", "name: primary\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "is reserved") {
		t.Fatalf("expected reserved-name error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsScaleSetNameCollisionAcrossRegistrations(t *testing.T) {
	body := strings.Replace(registrationYAML("/secrets/second.pem"), "name: second-default\n", "name: default\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), `duplicate scale set "default"`) {
		t.Fatalf("expected process-wide scale-set-name collision error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsIncompleteRegistrationApp(t *testing.T) {
	body := strings.Replace(registrationYAML("/secrets/second.pem"), "      installation_id: 99\n", "", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "app.installation_id must be a positive integer") {
		t.Fatalf("expected missing installation_id error, got %v", err)
	}
}

// The real orchestrator.yml now lives in jlapenna/homelab (this repo only
// owns the Go source), so the schema-drift check that used to load it
// directly here (`../orchestrator.yml`) moved with it: homelab's own deploy
// pipeline runs `runner-autoscaler --check-config` against the real file
// before restarting the live service, using the image this repo publishes.

func TestOrchestratorConfigDisabledRegistrationSkipsValidationAndCredentials(t *testing.T) {
	// A disabled registration keeps its real (obviously placeholder) shape in
	// the committed file -- including an installation_id of 0 and a
	// private_key_file that doesn't exist on disk -- without blocking
	// --check-config for every other registration in the same process.
	body := strings.Replace(registrationYAML("/secrets/does-not-exist.pem"), "installation_id: 99\n", "installation_id: 0\n", 1)
	body = strings.Replace(body, "    github:\n", "    disabled: true\n    github:\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("disabled registration should not fail validation: %v", err)
	}
	if len(resolved.ScaleSets) != 2 {
		t.Fatalf("disabled registration's scale sets should not be resolved: %#v", resolved.ScaleSets)
	}
	t.Setenv("APP_CLIENT_ID", "primary-client")
	t.Setenv("APP_INSTALLATION_ID", "42")
	keyPath := filepath.Join(t.TempDir(), "primary-app.pem")
	if err := os.WriteFile(keyPath, []byte("primary-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_PRIVATE_KEY_FILE", keyPath)
	if err := resolved.loadCredentials(); err != nil {
		t.Fatalf("disabled registration's missing private key should not be read: %v", err)
	}
}

// TestOrchestratorConfigRejectsAllDisabledRegistrations guards against
// runOrchestrator's resolved.ScaleSets[0] panicking on startup: a config
// with no primary scale_sets and only disabled registrations passes the
// raw "at least one of scale_sets or registrations must be set" check
// (registrations IS set) but must still fail validation once resolved,
// since it resolves to zero actual scale sets.
func TestOrchestratorConfigRejectsAllDisabledRegistrations(t *testing.T) {
	body := `
version: 1
server: {}
fleet:
  max_runners: 1
  hosts:
    - name: janeway
      docker: local
  placement: {}
registrations:
  - name: second
    disabled: true
    github:
      url: https://github.com/example/other-repo
    app:
      client_id: second-client
      installation_id: 0
      private_key_file: /secrets/does-not-exist.pem
    scale_sets:
      - name: second-default
        labels: [default]
        runner_image: example/second:latest
        min_runners: 0
        max_runners: 1
`
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "at least one enabled scale set is required") {
		t.Fatalf("expected 'at least one enabled scale set' error, got %v", err)
	}
}
