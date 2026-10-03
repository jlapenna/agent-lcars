package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
)

var (
	orchestratorConfigPath  string
	checkOrchestratorConfig bool
)

func init() {
	flags := cmd.Flags()
	flags.StringVar(&orchestratorConfigPath, "config", "/config/orchestrator.yml", "Path to the fleet orchestrator YAML")
	flags.BoolVar(&checkOrchestratorConfig, "check-config", false, "Validate configuration and credentials, including Kubernetes API access, without launching workers")
}

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}

var cmd = &cobra.Command{
	Use:   "runner-orchestrator",
	Short: "Run the LCARS queue executor, launching direct workers through Kubernetes or Docker",
	RunE: func(cmd *cobra.Command, args []string) error {
		resolved, err := loadOrchestratorConfig(orchestratorConfigPath)
		if err != nil {
			return err
		}
		for _, warning := range resolved.Warnings {
			slog.Default().Warn(warning)
		}
		if err := validateQueueExecutorEnvironment(resolved); err != nil {
			return err
		}
		if checkOrchestratorConfig {
			if resolved.Raw.Kubernetes != nil {
				// Use the same non-mutating fleet preflight as startup before a
				// deployment stops its old controller. SSAR checks permissions;
				// no Job, Secret or worker is created here.
				_, err := newKubernetesQueue(cmd.Context(), *resolved.Raw.Kubernetes, slog.Default())
				return err
			}
			return nil
		}
		ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return runOrchestrator(ctx, resolved)
	},
}
