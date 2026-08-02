package main

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// githubErrorBodySnippetLimit bounds how much of a non-2xx GitHub API
// response body gets folded into an error message: enough to show GitHub's
// "message"/"documentation_url" JSON body without risking an unbounded
// error string if a proxy or GitHub itself ever returns something huge.
const githubErrorBodySnippetLimit = 2 << 10 // 2 KiB

// runnerStatusRateLimitMinBackoff/MaxBackoff bound the wait this process
// honors when GitHub signals a rate limit (agent-lcars#321): never busy-loop
// on a Retry-After of 0, and never let a single bad/huge value from GitHub
// (or a misbehaving proxy) stall reconciliation indefinitely.
const (
	runnerStatusRateLimitMinBackoff = 5 * time.Second
	runnerStatusRateLimitMaxBackoff = 30 * time.Minute
)

// githubRateLimitError decorates a GitHub REST API error with how long the
// caller should wait before retrying. It always wraps an underlying error
// built by newGitHubHTTPError so Error() still carries the response status
// and body snippet.
type githubRateLimitError struct {
	retryAfter time.Duration
	err        error
}

func (e *githubRateLimitError) Error() string {
	return fmt.Sprintf("%s (retry after %s)", e.err, e.retryAfter)
}

func (e *githubRateLimitError) Unwrap() error { return e.err }

// newGitHubHTTPError builds an error for a non-2xx GitHub REST API response.
// It always includes the HTTP status and a bounded body snippet, and when
// the response signals a rate limit (429, or 403 carrying rate-limit
// headers) it returns a *githubRateLimitError so callers can back off
// instead of retrying on a fixed interval. The caller remains responsible
// for closing resp.Body; this only reads (never closes) it.
func newGitHubHTTPError(action string, resp *http.Response, now time.Time) error {
	base := fmt.Errorf("%s: unexpected %s: %s", action, resp.Status, readBoundedBody(resp, githubErrorBodySnippetLimit))
	if wait, limited := githubRateLimited(resp, now); limited {
		return &githubRateLimitError{retryAfter: wait, err: base}
	}
	return base
}

// readBoundedBody reads up to limit bytes of resp.Body for inclusion in an
// error message.
func readBoundedBody(resp *http.Response, limit int) string {
	if resp.Body == nil {
		return "(no body)"
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, int64(limit)))
	snippet := strings.TrimSpace(string(body))
	if snippet == "" {
		return "(empty body)"
	}
	return snippet
}

// githubRateLimited reports whether resp signals a GitHub REST API primary
// or secondary rate limit -- HTTP 429, or HTTP 403 carrying a Retry-After or
// X-RateLimit-Remaining: 0 header -- as opposed to an ordinary permission
// error, which also uses 403 but carries neither header. When limited, it
// returns how long to wait before the next attempt, preferring Retry-After,
// then X-RateLimit-Reset, then a floor default; the result is always capped
// between runnerStatusRateLimitMinBackoff and runnerStatusRateLimitMaxBackoff.
//
// See https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
func githubRateLimited(resp *http.Response, now time.Time) (wait time.Duration, limited bool) {
	if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode != http.StatusForbidden {
		return 0, false
	}
	hasRateLimitHeaders := resp.Header.Get("Retry-After") != "" || resp.Header.Get("X-RateLimit-Remaining") == "0"
	if resp.StatusCode == http.StatusForbidden && !hasRateLimitHeaders {
		return 0, false
	}

	if raw := strings.TrimSpace(resp.Header.Get("Retry-After")); raw != "" {
		if secs, err := strconv.Atoi(raw); err == nil && secs >= 0 {
			return capRateLimitBackoff(time.Duration(secs) * time.Second), true
		}
	}
	if raw := strings.TrimSpace(resp.Header.Get("X-RateLimit-Reset")); raw != "" {
		if epoch, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return capRateLimitBackoff(time.Unix(epoch, 0).Sub(now)), true
		}
	}
	return runnerStatusRateLimitMinBackoff, true
}

func capRateLimitBackoff(d time.Duration) time.Duration {
	switch {
	case d < runnerStatusRateLimitMinBackoff:
		return runnerStatusRateLimitMinBackoff
	case d > runnerStatusRateLimitMaxBackoff:
		return runnerStatusRateLimitMaxBackoff
	default:
		return d
	}
}
