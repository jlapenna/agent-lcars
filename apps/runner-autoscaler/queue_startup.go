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
func validateQueueExecutorEnvironment(cfg OrchestratorConfig) error {
	if strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL")) == "" {
		return fmt.Errorf("queue executor: LCARS_CONSOLE_URL is required for the queue executor; this process has nothing else to run")
	}
	if strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")) == "" {
		return fmt.Errorf("queue executor: GOOGLE_APPLICATION_CREDENTIALS is required for the queue executor")
	}
	scheduler := strings.TrimSpace(os.Getenv("LCARS_SCHEDULER_CREDENTIALS"))
	if runsScheduleTicker(cfg) {
		if scheduler == "" {
			return fmt.Errorf("queue executor: LCARS_SCHEDULER_CREDENTIALS is required for the schedule and maintenance ticker")
		}
	} else if scheduler != "" {
		// The schedule ticker belongs to the shared executor. A zone holding
		// the work.cron key would be a second schedule owner; refuse it.
		return fmt.Errorf("queue executor: a runtimes_only zone executor runs no schedule ticker; unset LCARS_SCHEDULER_CREDENTIALS")
	}
	return validateKubernetesQueueEnvironment(cfg.Kubernetes)
}

// runsScheduleTicker reports whether this executor owns the schedule and
// maintenance ticker. Only the shared executor does: a runtimes_only zone
// executor claims its declared runtimes and nothing else.
func runsScheduleTicker(cfg OrchestratorConfig) bool {
	return cfg.Kubernetes == nil || !cfg.Kubernetes.RuntimesOnly
}
