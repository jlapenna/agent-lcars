package main

import (
	"fmt"
	"os"
	"strings"
)

// validateQueueExecutorEnvironment is the environment-only preflight shared by
// normal boot and --check-config. It does not contact the Kubernetes API, mint
// tokens, or perform a mutation.
//
// The queue executor is this process's only job, so an unconfigured queue
// executor always means nothing would run. That must fail loudly at startup
// (and at --check-config) rather than leave the process running forever as a
// silent no-op.
func validateQueueExecutorEnvironment(resolved resolvedOrchestratorConfig) error {
	consoleURL := strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL"))
	_, state, reason := queueExecutorStartupStatus(consoleURL, os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"))
	if state == queueExecutorStateDisabled {
		return fmt.Errorf("queue executor: %s; this process has nothing else to run", reason)
	}
	if state != queueExecutorStateReady {
		return fmt.Errorf("queue executor: %s", reason)
	}
	return validateKubernetesQueueEnvironment(resolved.Raw.Kubernetes)
}
