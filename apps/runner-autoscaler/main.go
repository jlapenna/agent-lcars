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
	flags.BoolVar(&checkOrchestratorConfig, "check-config", false, "Validate configuration and credentials, then exit without network or Docker mutations")
}

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}

var cmd = &cobra.Command{
	Use:   "runner-orchestrator",
	Short: "Run the LCARS queue executor, launching direct-runner containers across one Docker fleet",
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
			return nil
		}
		ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return runOrchestrator(ctx, resolved)
	},
}
