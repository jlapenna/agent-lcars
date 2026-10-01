package main

import (
	"testing"
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
