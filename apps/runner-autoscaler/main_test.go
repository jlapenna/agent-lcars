package main

import (
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
