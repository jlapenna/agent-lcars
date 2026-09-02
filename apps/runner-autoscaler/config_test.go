package main

import "testing"

func TestConfigValidation(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr bool
	}{
		{
			name: "valid config with token",
			cfg: Config{
				RegistrationURL: "https://github.com/org/repo",
				ScaleSetName:    "test-scaleset",
				Token:           "ghp_secret",
				RunnerImage:     "registry.example/mirror/actions-runner:latest",
				MinRunners:      0,
				MaxRunners:      5,
			},
			wantErr: false,
		},
		{
			name: "missing runner image",
			cfg: Config{
				RegistrationURL: "https://github.com/org/repo",
				ScaleSetName:    "test-scaleset",
				Token:           "ghp_secret",
			},
			wantErr: true,
		},
		{
			name: "invalid registration URL",
			cfg: Config{
				RegistrationURL: "invalid-url",
				ScaleSetName:    "test-scaleset",
				Token:           "ghp_secret",
			},
			wantErr: true,
		},
		{
			name: "missing credentials",
			cfg: Config{
				RegistrationURL: "https://github.com/org/repo",
				ScaleSetName:    "test-scaleset",
			},
			wantErr: true,
		},
		{
			name: "max runners less than min runners",
			cfg: Config{
				RegistrationURL: "https://github.com/org/repo",
				ScaleSetName:    "test-scaleset",
				Token:           "ghp_secret",
				MinRunners:      10,
				MaxRunners:      2,
			},
			wantErr: true,
		},
		{
			name: "invalid docker host format",
			cfg: Config{
				RegistrationURL: "https://github.com/org/repo",
				ScaleSetName:    "test-scaleset",
				Token:           "ghp_secret",
				DockerHosts:     []string{"invalid-entry"},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Config.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestConfigEmptyDisablesFeatures verifies that a nil InferenceMetricsURLs
// map survives Validate(): empty/nil is a meaningful, documented "no host
// carries a probe" value, and defaults() deliberately does not fill it in.
func TestConfigEmptyDisablesFeatures(t *testing.T) {
	cfg := Config{
		RegistrationURL:      "https://github.com/org/repo",
		ScaleSetName:         "x",
		Token:                "t",
		RunnerImage:          "registry.example/mirror/actions-runner:latest",
		InferenceMetricsURLs: nil,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Config.Validate() returned unexpected error: %v", err)
	}
	if len(cfg.InferenceMetricsURLs) != 0 {
		t.Errorf("expected InferenceMetricsURLs to remain empty after Validate(), got %v", cfg.InferenceMetricsURLs)
	}
}

// TestConfigDefaultsLeaveRunnerImageEmpty covers agent-lcars#1728: there is
// no fleet-named default runner image, so an unset scale_sets[].runner_image
// stays empty through defaults() and Validate() rejects it explicitly below
// (TestConfigRequiresRunnerImage) rather than silently guessing a registry.
func TestConfigDefaultsLeaveRunnerImageEmpty(t *testing.T) {
	cfg := Config{}
	cfg.defaults()

	if cfg.RunnerImage != "" {
		t.Errorf("RunnerImage default = %q, want empty (no fleet-named default)", cfg.RunnerImage)
	}
}

func TestConfigRequiresRunnerImage(t *testing.T) {
	cfg := Config{
		RegistrationURL: "https://github.com/org/repo",
		ScaleSetName:    "test-scaleset",
		Token:           "ghp_secret",
	}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Config.Validate() accepted a config with no runner image")
	}
	if got := err.Error(); got != "runner image is required" {
		t.Errorf("Validate() error = %q, want %q", got, "runner image is required")
	}
}

func TestConfigRejectsDigestRunnerImage(t *testing.T) {
	cfg := Config{
		RegistrationURL: "https://github.com/org/repo",
		ScaleSetName:    "test-scaleset",
		Token:           "ghp_secret",
		RunnerImage:     "registry.example/runner@sha256:0123456789abcdef",
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Config.Validate() accepted a digest runner image")
	}
}

func TestBuildLabels(t *testing.T) {
	t.Run("default to scale set name", func(t *testing.T) {
		cfg := Config{ScaleSetName: "my-scale-set"}
		labels := cfg.BuildLabels()
		if len(labels) != 1 || labels[0].Name != "my-scale-set" {
			t.Errorf("expected label my-scale-set, got %v", labels)
		}
	})

	t.Run("explicit labels", func(t *testing.T) {
		cfg := Config{
			ScaleSetName: "my-scale-set",
			Labels:       []string{"default", "e2e-docker"},
		}
		labels := cfg.BuildLabels()
		if len(labels) != 2 || labels[0].Name != "default" || labels[1].Name != "e2e-docker" {
			t.Errorf("expected default and e2e-docker labels, got %v", labels)
		}
	})
}
