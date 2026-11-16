package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// A brief carries Work text and, for a repository-owned claw agent, the
// agent's whole pinned definition (docs/repository-agents.md), so it has no
// fixed size. The fence needs only its intentId: it stream-decodes the body
// instead of buffering it, bounded by the client timeout.
// The brief route is already read-only and requires this exact run's token,
// liveness and unexpired startup/execution deadline. It grants no new credential or Work authority.
// The worker checks it again at bootstrap, fencing a settlement that races
// the Kubernetes update. Never log the token, response body or request URL.
func queueRunFence(consoleURL string) func(context.Context, string, string) error {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, runID, token string) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(consoleURL, "/")+"/api/work/v1/runs/"+url.PathEscape(runID)+"/brief", nil)
		if err != nil {
			return fmt.Errorf("building queue run-token fence request")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("queue run-token fence request unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("queue run-token fence returned HTTP %d", response.StatusCode)
		}
		var brief struct {
			IntentID string `json:"intentId"`
		}
		if json.NewDecoder(response.Body).Decode(&brief) != nil || brief.IntentID != runID {
			return fmt.Errorf("queue run-token fence brief identity conflict")
		}
		return nil
	}
}
