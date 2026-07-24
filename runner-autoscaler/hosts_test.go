package main

import (
	"reflect"
	"testing"
)

func TestParseDockerHosts(t *testing.T) {
	t.Run("valid hosts entry", func(t *testing.T) {
		entries := []string{"local=local", "pike=ssh://homelab@pike.lan.jlapenna.net"}
		targets, order, err := ParseDockerHosts(entries)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		expectedTargets := map[string]string{
			"local": "local",
			"pike":  "ssh://homelab@pike.lan.jlapenna.net",
		}
		expectedOrder := []string{"local", "pike"}
		if !reflect.DeepEqual(targets, expectedTargets) {
			t.Errorf("expected targets %v, got %v", expectedTargets, targets)
		}
		if !reflect.DeepEqual(order, expectedOrder) {
			t.Errorf("expected order %v, got %v", expectedOrder, order)
		}
	})

	t.Run("invalid entry format", func(t *testing.T) {
		entries := []string{"invalid-no-equals"}
		_, _, err := ParseDockerHosts(entries)
		if err == nil {
			t.Errorf("expected error for invalid entry format")
		}
	})

	t.Run("duplicate host name", func(t *testing.T) {
		entries := []string{"pike=local", "pike=ssh://homelab@pike.lan.jlapenna.net"}
		_, _, err := ParseDockerHosts(entries)
		if err == nil {
			t.Errorf("expected error for duplicate host name")
		}
	})
}
