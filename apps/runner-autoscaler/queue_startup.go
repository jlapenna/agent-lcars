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
// silent no-op. An absent console URL is named as exactly that condition; any
// other missing value is an incomplete deployment.
func validateQueueExecutorEnvironment(resolved resolvedOrchestratorConfig) error {
	if strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL")) == "" {
		return fmt.Errorf("queue executor: LCARS_CONSOLE_URL is required for the queue executor; this process has nothing else to run")
	}
	if strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")) == "" {
		return fmt.Errorf("queue executor: GOOGLE_APPLICATION_CREDENTIALS is required for the queue executor")
	}
	return validateKubernetesQueueEnvironment(resolved.Raw.Kubernetes)
}
