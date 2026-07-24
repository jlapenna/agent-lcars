package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/actions/scaleset"
	"github.com/docker/docker/api/types/image"
	"github.com/spf13/cobra"
)

var (
	orchestratorConfigPath  string
	checkOrchestratorConfig bool
)

func init() {
	flags := cmd.Flags()
	flags.StringVar(&orchestratorConfigPath, "config", "/config/orchestrator.yml", "Path to the multi-scale-set orchestrator YAML")
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
	Short: "Supervise GitHub scale-set listeners and schedule runners across one Docker fleet",
	RunE: func(cmd *cobra.Command, args []string) error {
		resolved, err := loadOrchestratorConfig(orchestratorConfigPath)
		if err != nil {
			return err
		}
		if err := resolved.loadCredentials(); err != nil {
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

// warnIfAdoptedLabelsDiffer surfaces routing drift but never silently mutates
// a live scale set's labels.
func warnIfAdoptedLabelsDiffer(logger *slog.Logger, adopted, configured []scaleset.Label) {
	if len(adopted) == 0 || equalLabelSets(labelNameSet(adopted), labelNameSet(configured)) {
		return
	}
	logger.Warn("Adopted scale set labels differ from orchestrator config; adoption does not update GitHub",
		slog.Any("adoptedLabels", adopted), slog.Any("configuredLabels", configured))
}

func labelNameSet(labels []scaleset.Label) map[string]bool {
	set := make(map[string]bool, len(labels))
	for _, label := range labels {
		set[strings.ToLower(label.Name)] = true
	}
	return set
}

func equalLabelSets(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for key := range a {
		if !b[key] {
			return false
		}
	}
	return true
}

// pullRunnerImages refreshes each distinct runner image on all fleet hosts in
// parallel. A slow or unavailable host never blocks healthy hosts.
func pullRunnerImages(ctx context.Context, hosts []DockerHost, runnerImage string, logger *slog.Logger) {
	var wg sync.WaitGroup
	for _, host := range hosts {
		wg.Add(1)
		go func(host DockerHost) {
			defer wg.Done()
			pullCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
			defer cancel()
			logger.Info("Pulling runner image", slog.String("host", host.Name), slog.String("image", runnerImage))
			pull, err := host.Client.ImagePull(pullCtx, runnerImage, image.PullOptions{})
			if err != nil {
				if _, inspectErr := host.Client.ImageInspect(ctx, runnerImage); inspectErr == nil {
					logger.Warn("Failed to pull runner image; using cached copy", slog.String("host", host.Name), slog.String("error", err.Error()))
				} else {
					logger.Error("Failed to pull runner image and no cached copy exists", slog.String("host", host.Name), slog.String("error", err.Error()))
				}
				return
			}
			defer func() { _ = pull.Close() }()
			if _, err := io.Copy(io.Discard, pull); err != nil {
				logger.Warn("Failed while reading image pull response", slog.String("host", host.Name), slog.String("error", err.Error()))
			}
		}(host)
	}
	wg.Wait()
}
