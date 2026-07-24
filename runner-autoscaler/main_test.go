package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSystemInfo(t *testing.T) {
	info := systemInfo(123)
	if info.ScaleSetID != 123 {
		t.Errorf("expected scaleSetID 123, got %d", info.ScaleSetID)
	}
	if info.System != "dockerscaleset" || info.Subsystem != "dockerscaleset" {
		t.Errorf("unexpected system info: %v", info)
	}
}

func TestLoadPrivateKeyFile(t *testing.T) {
	tmpDir := t.TempDir()
	keyFile := filepath.Join(tmpDir, "test_key.pem")
	dummyPEM := "-----BEGIN RSA PRIVATE KEY-----\ntest-key-data\n-----END RSA PRIVATE KEY-----"

	if err := os.WriteFile(keyFile, []byte(dummyPEM), 0600); err != nil {
		t.Fatalf("failed to write dummy key file: %v", err)
	}

	cfg := Config{
		PrivateKeyFile: keyFile,
	}

	if err := cfg.loadPrivateKeyFile(); err != nil {
		t.Fatalf("loadPrivateKeyFile failed: %v", err)
	}

	if cfg.GitHubApp.PrivateKey != dummyPEM {
		t.Errorf("expected private key %q, got %q", dummyPEM, cfg.GitHubApp.PrivateKey)
	}
}

func TestCommandFlags(t *testing.T) {
	for _, name := range []string{"config", "check-config"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Errorf("expected --%s flag to be registered", name)
		}
	}
	for _, removed := range []string{"url", "name", "runner-memory", "app-private-key-file"} {
		if cmd.Flags().Lookup(removed) != nil {
			t.Errorf("legacy --%s flag must not remain in orchestrator mode", removed)
		}
	}
}
