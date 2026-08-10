package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func generateTestAppKey(t *testing.T) (*rsa.PrivateKey, []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return key, pemBytes
}

func TestInstallationTokenSourceSignsAndCachesAppToken(t *testing.T) {
	key, privateKey := generateTestAppKey(t)
	now := time.Now().UTC()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/app/installations/42/access_tokens" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		rawJWT := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		parsed, err := jwt.ParseWithClaims(rawJWT, &jwt.RegisteredClaims{}, func(token *jwt.Token) (any, error) {
			return &key.PublicKey, nil
		})
		if err != nil || !parsed.Valid {
			t.Fatalf("invalid app JWT: %v", err)
		}
		claims := parsed.Claims.(*jwt.RegisteredClaims)
		if claims.Issuer != "client-id" {
			t.Fatalf("issuer = %q", claims.Issuer)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"token":"installation-token","expires_at":%q}`, now.Add(time.Hour).Format(time.RFC3339))
	}))
	defer server.Close()

	source, err := newInstallationTokenSource("client-id", 42, string(privateKey), server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	source.now = func() time.Time { return now }

	first, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != "installation-token" || second != first || requests != 1 {
		t.Fatalf("tokens/requests = %q/%q/%d", first, second, requests)
	}
}

// TestInstallationTokenSourceRefreshesBeforeExpiry mints a token that is
// only barely inside the 1-minute refresh-before-expiry window and confirms
// the next Token() call re-mints instead of serving the stale cached value.
func TestInstallationTokenSourceRefreshesBeforeExpiry(t *testing.T) {
	_, privateKey := generateTestAppKey(t)
	start := time.Now().UTC()
	var clock time.Time = start
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"token":"token-%d","expires_at":%q}`, requests, start.Add(10*time.Minute).Format(time.RFC3339))
	}))
	defer server.Close()

	source, err := newInstallationTokenSource("client-id", 42, string(privateKey), server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	source.now = func() time.Time { return clock }

	first, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != "token-1" || requests != 1 {
		t.Fatalf("first token/requests = %q/%d, want token-1/1", first, requests)
	}

	// Still safely cached: well under expiry - 1 minute.
	clock = start.Add(5 * time.Minute)
	cached, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cached != first || requests != 1 {
		t.Fatalf("expected cached token reused, got %q/%d requests", cached, requests)
	}

	// Inside the 1-minute refresh window (expiry is start+10m): must re-mint.
	clock = start.Add(9*time.Minute + 30*time.Second)
	refreshed, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if refreshed == first || requests != 2 {
		t.Fatalf("expected a refreshed token, got %q/%d requests (first was %q)", refreshed, requests, first)
	}
}

// TestInstallationTokenSourceNon201ErrorIncludesDetail verifies the mint
// error surfaces the response status and a body snippet instead of the old
// bare "HTTP %d" message (agent-lcars#321).
func TestInstallationTokenSourceNon201ErrorIncludesDetail(t *testing.T) {
	_, privateKey := generateTestAppKey(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, `{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}`)
	}))
	defer server.Close()

	source, err := newInstallationTokenSource("client-id", 42, string(privateKey), server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}

	_, err = source.Token(context.Background())
	if err == nil {
		t.Fatal("Token: want error, got nil")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error %q missing status code", err.Error())
	}
	if !strings.Contains(err.Error(), "Bad credentials") {
		t.Fatalf("error %q missing response body detail", err.Error())
	}
}

// TestInstallationTokenSourceRateLimitedMintPropagatesRetryAfter verifies a
// 429 (or 403-with-rate-limit-headers) on the token-mint call site is
// classified as a rate limit -- not just a generic failure -- so the
// runner-status reconciler that calls Token() indirectly through
// ListRunnerStatuses can back off (agent-lcars#321).
func TestInstallationTokenSourceRateLimitedMintPropagatesRetryAfter(t *testing.T) {
	_, privateKey := generateTestAppKey(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "12")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, `{"message":"You have exceeded a secondary rate limit"}`)
	}))
	defer server.Close()

	source, err := newInstallationTokenSource("client-id", 42, string(privateKey), server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}

	_, err = source.Token(context.Background())
	var rateLimited *githubRateLimitError
	if !errors.As(err, &rateLimited) {
		t.Fatalf("error = %v, want *githubRateLimitError", err)
	}
	if rateLimited.retryAfter != 12*time.Second {
		t.Fatalf("retryAfter = %s, want 12s", rateLimited.retryAfter)
	}
}

func TestNewInstallationTokenSourceRejectsInvalidPrivateKey(t *testing.T) {
	if _, err := newInstallationTokenSource("client-id", 42, "not a pem key", "https://api.github.com", http.DefaultClient); err == nil {
		t.Fatal("newInstallationTokenSource: want error for invalid PEM, got nil")
	}
}
