package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newTestResponse(t *testing.T, status int, headers map[string]string, body string) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	for k, v := range headers {
		rec.Header().Set(k, v)
	}
	rec.WriteHeader(status)
	_, _ = io.WriteString(rec, body)
	resp := rec.Result()
	return resp
}

func TestGitHubRateLimitedOn429UsesRetryAfter(t *testing.T) {
	resp := newTestResponse(t, http.StatusTooManyRequests, map[string]string{"Retry-After": "17"}, "")
	wait, limited := githubRateLimited(resp, time.Now())
	if !limited {
		t.Fatal("429 not detected as rate limited")
	}
	if wait != 17*time.Second {
		t.Fatalf("wait = %s, want 17s", wait)
	}
}

// TestGitHubRateLimitedOn429WithoutHeadersUsesPollIntervalFloor pins down
// that a headerless rate limit -- no Retry-After, no usable
// X-RateLimit-Reset -- waits at least runnerStatusPollInterval (60s), per
// GitHub's secondary-rate-limit guidance to wait at least one minute in that
// case. Regressing this to the 5s header-derived floor would hammer GitHub
// far more aggressively than the fixed-60s-poll behavior this feature
// replaced.
func TestGitHubRateLimitedOn429WithoutHeadersUsesPollIntervalFloor(t *testing.T) {
	resp := newTestResponse(t, http.StatusTooManyRequests, nil, "")
	wait, limited := githubRateLimited(resp, time.Now())
	if !limited {
		t.Fatal("429 not detected as rate limited")
	}
	if wait < runnerStatusPollInterval {
		t.Fatalf("wait = %s, want >= %s (GitHub's documented secondary-rate-limit minimum)", wait, runnerStatusPollInterval)
	}
	if wait != runnerStatusRateLimitFallbackBackoff {
		t.Fatalf("wait = %s, want exactly the fallback constant %s", wait, runnerStatusRateLimitFallbackBackoff)
	}
}

// TestGitHubRateLimitedOn403WithRateLimitRemainingZeroWithoutResetUsesPollIntervalFloor
// covers the other headerless path: X-RateLimit-Remaining: 0 signals a rate
// limit but there is no (or an unparseable) X-RateLimit-Reset to size the
// wait from.
func TestGitHubRateLimitedOn403WithRateLimitRemainingZeroWithoutResetUsesPollIntervalFloor(t *testing.T) {
	resp := newTestResponse(t, http.StatusForbidden, map[string]string{"X-RateLimit-Remaining": "0"}, "")
	wait, limited := githubRateLimited(resp, time.Now())
	if !limited {
		t.Fatal("403 with exhausted rate limit not detected")
	}
	if wait < runnerStatusPollInterval {
		t.Fatalf("wait = %s, want >= %s", wait, runnerStatusPollInterval)
	}
}

func TestGitHubRateLimitedOn403WithRateLimitResetHeader(t *testing.T) {
	now := time.Now()
	reset := now.Add(2 * time.Minute)
	resp := newTestResponse(t, http.StatusForbidden, map[string]string{
		"X-RateLimit-Remaining": "0",
		"X-RateLimit-Reset":     strconv.FormatInt(reset.Unix(), 10),
	}, "")
	wait, limited := githubRateLimited(resp, now)
	if !limited {
		t.Fatal("403 with exhausted rate limit not detected")
	}
	// Rounding through Unix() can lose sub-second precision.
	if diff := wait - 2*time.Minute; diff < -time.Second || diff > time.Second {
		t.Fatalf("wait = %s, want ~2m", wait)
	}
}

func TestGitHubRateLimitedOrdinary403IsNotRateLimited(t *testing.T) {
	resp := newTestResponse(t, http.StatusForbidden, nil, "")
	if _, limited := githubRateLimited(resp, time.Now()); limited {
		t.Fatal("ordinary 403 (no rate-limit headers) misclassified as rate limited")
	}
}

func TestGitHubRateLimitedOrdinaryErrorStatusIsNotRateLimited(t *testing.T) {
	resp := newTestResponse(t, http.StatusInternalServerError, map[string]string{"Retry-After": "5"}, "")
	if _, limited := githubRateLimited(resp, time.Now()); limited {
		t.Fatal("500 misclassified as rate limited")
	}
}

func TestCapRateLimitBackoffClampsToBounds(t *testing.T) {
	if got := capRateLimitBackoff(0); got != runnerStatusRateLimitMinBackoff {
		t.Fatalf("capRateLimitBackoff(0) = %s, want floor %s", got, runnerStatusRateLimitMinBackoff)
	}
	if got := capRateLimitBackoff(time.Hour); got != runnerStatusRateLimitMaxBackoff {
		t.Fatalf("capRateLimitBackoff(1h) = %s, want ceiling %s", got, runnerStatusRateLimitMaxBackoff)
	}
	if got := capRateLimitBackoff(time.Minute); got != time.Minute {
		t.Fatalf("capRateLimitBackoff(1m) = %s, want unchanged 1m", got)
	}
}

func TestNewGitHubHTTPErrorIncludesStatusAndBodySnippet(t *testing.T) {
	resp := newTestResponse(t, http.StatusNotFound, nil, `{"message":"Not Found","documentation_url":"https://docs.github.com"}`)
	err := newGitHubHTTPError("listing GitHub runners", resp, time.Now())
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "listing GitHub runners") {
		t.Fatalf("error %q missing action context", err.Error())
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("error %q missing status code", err.Error())
	}
	if !strings.Contains(err.Error(), "Not Found") || !strings.Contains(err.Error(), "documentation_url") {
		t.Fatalf("error %q missing response body detail", err.Error())
	}
	var rateLimited *githubRateLimitError
	if errors.As(err, &rateLimited) {
		t.Fatalf("404 misclassified as rate limit: %v", err)
	}
}

func TestNewGitHubHTTPErrorTruncatesLargeBody(t *testing.T) {
	huge := strings.Repeat("x", githubErrorBodySnippetLimit*4)
	resp := newTestResponse(t, http.StatusInternalServerError, nil, huge)
	err := newGitHubHTTPError("listing GitHub runners", resp, time.Now())
	if len(err.Error()) >= len(huge) {
		t.Fatalf("error body was not bounded: len(error)=%d, len(body)=%d", len(err.Error()), len(huge))
	}
}

func TestNewGitHubHTTPErrorWrapsRateLimitDetail(t *testing.T) {
	resp := newTestResponse(t, http.StatusTooManyRequests, map[string]string{"Retry-After": "9"}, `{"message":"secondary rate limit"}`)
	err := newGitHubHTTPError("listing GitHub runners", resp, time.Now())
	var rateLimited *githubRateLimitError
	if !errors.As(err, &rateLimited) {
		t.Fatalf("error %v does not unwrap to *githubRateLimitError", err)
	}
	if rateLimited.retryAfter != 9*time.Second {
		t.Fatalf("retryAfter = %s, want 9s", rateLimited.retryAfter)
	}
	if !strings.Contains(err.Error(), "secondary rate limit") {
		t.Fatalf("error %q missing body snippet", err.Error())
	}
	if !strings.Contains(err.Error(), "retry after 9s") {
		t.Fatalf("error %q missing retry-after detail", err.Error())
	}
}
