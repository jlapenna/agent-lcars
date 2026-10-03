package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Immutable for one daemon generation, including across SIGHUP. Only credential
// file paths are captured: the runner still reads rotated file contents per run.
type queueExecutorResolved struct {
	resolvedOrchestratorConfig
	targets       map[string]string
	order         []string
	image         string
	writerPath    string
	maxConcurrent int
	mounts        []directRunnerCredentialMount
	binds         map[string][]string
}

func resolveQueueExecutor(resolved resolvedOrchestratorConfig) (queueExecutorResolved, error) {
	q := queueExecutorResolved{resolvedOrchestratorConfig: resolved, binds: make(map[string][]string)}
	q.DockerHosts = append([]string(nil), resolved.DockerHosts...)
	var err error
	if q.targets, q.order, err = ParseDockerHosts(resolved.DockerHosts); err != nil {
		return q, err
	}
	if len(q.order) == 0 {
		return q, fmt.Errorf("no Docker hosts configured for queue executor")
	}
	if q.image, err = directRunnerImage(); err != nil {
		return q, err
	}
	if q.writerPath, err = directRunnerTelemetryWriterHostPath(); err != nil {
		return q, err
	}
	if q.maxConcurrent, err = directRunnerMaxConcurrent(); err != nil {
		return q, err
	}
	q.mounts = []directRunnerCredentialMount{{hostPath: q.writerPath, containerPath: directRunnerTelemetryWriterMountPath}}
	for _, adapter := range directRunnerAdapters {
		mounts, err := adapter.credentialMounts()
		if err != nil {
			return q, fmt.Errorf("%s adapter: %w", adapter.pipeline, err)
		}
		q.mounts = append(q.mounts, mounts...)
		q.binds[adapter.pipeline] = []string{}
		for _, mount := range mounts {
			q.binds[adapter.pipeline] = append(q.binds[adapter.pipeline], mount.bind())
		}
	}
	return q, nil
}

// Environment-only preflight is shared by normal boot and --check-config. It
// does not contact Docker, mint tokens, or perform a container mutation.
//
// Since homelab#1623 Phase 3 retired the scale-set runtime, the queue
// executor is this process's only possible job: an unconfigured queue
// executor always means nothing would run, and that must fail loudly at
// startup (and at --check-config) rather than leave the process running
// forever as a silent no-op that never touches Docker or the console.
func validateQueueExecutorEnvironment(resolved resolvedOrchestratorConfig) error {
	if resolved.Raw.Kubernetes != nil {
		return validateKubernetesQueueEnvironment(resolved.Raw.Kubernetes)
	}
	consoleURL := strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL"))
	_, state, reason := queueExecutorStartupStatus(consoleURL, os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"), os.Getenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH"))
	if state == queueExecutorStateDisabled {
		return fmt.Errorf("queue executor: %s; this process has nothing else to run", reason)
	}
	if state != queueExecutorStateReady {
		return fmt.Errorf("queue executor: %s", reason)
	}
	parsed, err := url.Parse(consoleURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("LCARS_CONSOLE_URL must be an absolute HTTP(S) URL")
	}
	_, err = resolveQueueExecutor(resolved)
	return err
}
