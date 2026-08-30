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
				MinRunners:      0,
				MaxRunners:      5,
			},
			wantErr: false,
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

// TestConfigEmptyDisablesFeatures verifies that an explicitly empty
// SparkMetricsURL survives Validate() as empty: empty is a meaningful,
// documented "feature disabled" value, and defaults() deliberately does not
// fill it in (the cobra flags in main.go supply the non-empty default for
// the unset case instead -- see Config.defaults's comment).
func TestConfigEmptyDisablesFeatures(t *testing.T) {
	cfg := Config{
		RegistrationURL: "https://github.com/org/repo",
		ScaleSetName:    "x",
		Token:           "t",
		SparkMetricsURL: "",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Config.Validate() returned unexpected error: %v", err)
	}
	if cfg.SparkMetricsURL != "" {
		t.Errorf("expected SparkMetricsURL to remain empty after Validate(), got %q", cfg.SparkMetricsURL)
	}
}

func TestConfigDefaultsUseInternalRunnerMirror(t *testing.T) {
	cfg := Config{}
	cfg.defaults()

	if got, want := cfg.RunnerImage, "docker-registry.lan.jlapenna.net/mirror/actions-runner:latest"; got != want {
		t.Errorf("RunnerImage default = %q, want %q", got, want)
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
