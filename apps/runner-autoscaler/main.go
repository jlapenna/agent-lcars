package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/actions/scaleset"
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
		if len(resolved.Warnings) > 0 {
			startupLogger := slog.Default()
			if len(resolved.ScaleSets) > 0 {
				startupLogger = resolved.ScaleSets[0].Logger()
			}
			for _, warning := range resolved.Warnings {
				startupLogger.Warn(warning)
			}
		}
		// Probed before --check-config returns, so the preflight the deploy
		// runs catches a missing or unwritable state volume rather than the
		// process discovering it after cutover.
		if err := verifyCheckpointWritable(resolved.Raw.Server.StatePath); err != nil {
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

// logDigests records the content-addressable digest(s) actually resolved
// for runnerImage on host after a pull, for audit purposes. Image pulls are
// tag-only trust (see agent-lcars#96/#101) -- this doesn't prevent a
// registry from silently serving different content under the same tag, but
// it leaves a trail that lets a compromise be detected/investigated after
// the fact by diffing digests across pulls, which today's logs don't
// capture at all.
func logDigests(ctx context.Context, logger *slog.Logger, host DockerHost, runnerImage string) {
	inspectCtx, cancel := context.WithTimeout(ctx, dockerInspectTimeout)
	defer cancel()
	inspect, err := host.Client.ImageInspect(inspectCtx, runnerImage)
	if err != nil {
		logger.Warn("Pulled runner image but could not inspect it for a digest", slog.String("host", host.Name), slog.String("image", runnerImage), slog.String("error", err.Error()))
		return
	}
	logger.Info("Pulled runner image", slog.String("host", host.Name), slog.String("image", runnerImage), slog.Any("digests", inspect.RepoDigests))
}

// pullRunnerImages refreshes each distinct runner image on all fleet hosts in
// parallel. A slow or unavailable host never blocks healthy hosts.
func pullRunnerImages(ctx context.Context, hosts []DockerHost, runnerImage string, logger *slog.Logger) {
	var wg sync.WaitGroup
	for _, host := range hosts {
		wg.Add(1)
		go func(host DockerHost) {
			defer wg.Done()
			logger.Info("Pulling runner image", slog.String("host", host.Name), slog.String("image", runnerImage))
			err := pullRunnerImage(ctx, host.Client, runnerImage, host.Name)
			if err != nil {
				if _, inspectErr := host.Client.ImageInspect(ctx, runnerImage); inspectErr == nil {
					logger.Warn("Failed to pull runner image; using cached copy", slog.String("host", host.Name), slog.String("error", err.Error()))
				} else {
					logger.Error("Failed to pull runner image and no cached copy exists", slog.String("host", host.Name), slog.String("error", err.Error()))
				}
				return
			}
			logDigests(ctx, logger, host, runnerImage)
		}(host)
	}
	wg.Wait()
}
