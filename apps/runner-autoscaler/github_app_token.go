package main

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

// This file holds the SINGLE GitHub App installation-token implementation
// used by the runner-status reconciler's plain REST calls (agent-lcars#321,
// consolidating what #248 added ad hoc into runner_status.go). It is
// intentionally separate from -- and shares no code or abstraction with --
// the scaleset library's own GitHub App auth (config.go's ScalesetClient /
// scaleset.NewClientWithGitHubApp), which authenticates the unrelated scale-
// set/Actions admin API and is left untouched.
//
// A well-maintained third-party installation-token client
// (github.com/bradleyfalzon/ghinstallation/v2) was evaluated first, per the
// project's stated preference for a mature library over hand-rolled JWT
// code. It was not used: every version back through v2.5.0 hardcodes the JWT
// `iss` claim to strconv.FormatInt(appID, 10) (see AppsTransport.RoundTrip),
// i.e. it requires a numeric GitHub App ID and provides no hook to override
// the claim. This codebase's Config.GitHubApp.ClientID (fed from the same
// operator-supplied value scaleset.GitHubAppAuth.ClientID uses for stack
// (a)) is documented and exercised in tests as an opaque string -- the
// GitHub App's Client ID (e.g. "Iv1.xxxx"), which GitHub also accepts as a
// JWT issuer, not necessarily the numeric App ID. Forcing this one code path
// onto a numeric-only ID would silently break any deployment configured
// with a string client ID and would make the two remaining GitHub App auth
// paths accept different ID formats for what operators expect to be a
// single value -- real dependency friction, not a clean fit. So this stays
// a single, well-factored hand-rolled implementation instead.

// bearerTokenSource returns a bearer token for GitHub REST API calls. Each
// call to Token may return a cached value or fetch/refresh a new one.
type bearerTokenSource interface {
	Token(context.Context) (string, error)
}

// staticBearerToken is the bearerTokenSource for the personal-access-token
// fallback path (no GitHub App configured).
type staticBearerToken string

func (t staticBearerToken) Token(context.Context) (string, error) {
	return string(t), nil
}

// installationTokenSource mints and caches a GitHub App installation access
// token by signing a short-lived RS256 JWT and exchanging it at
// /app/installations/<id>/access_tokens. It refreshes one minute before the
// cached token's expiry and is safe for concurrent use.
type installationTokenSource struct {
	mu             sync.Mutex
	clientID       string
	installationID int64
	signingKey     *rsa.PrivateKey
	apiBaseURL     string
	httpClient     *http.Client
	now            func() time.Time
	token          string
	expiresAt      time.Time
}

func newInstallationTokenSource(clientID string, installationID int64, privateKey, apiBaseURL string, httpClient *http.Client) (*installationTokenSource, error) {
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(privateKey))
	if err != nil {
		return nil, fmt.Errorf("parsing GitHub App private key: %w", err)
	}
	return &installationTokenSource{
		clientID:       clientID,
		installationID: installationID,
		signingKey:     key,
		apiBaseURL:     apiBaseURL,
		httpClient:     httpClient,
		now:            time.Now,
	}, nil
}

func (s *installationTokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if s.token != "" && now.Add(time.Minute).Before(s.expiresAt) {
		return s.token, nil
	}

	appJWT, err := s.signAppJWT(now)
	if err != nil {
		return "", fmt.Errorf("signing GitHub App JWT: %w", err)
	}

	endpoint := fmt.Sprintf("%s/app/installations/%d/access_tokens", s.apiBaseURL, s.installationID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+appJWT)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("creating GitHub App installation token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return "", newGitHubHTTPError("creating GitHub App installation token", resp, now)
	}

	var result struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decoding GitHub App installation token: %w", err)
	}
	if result.Token == "" || result.ExpiresAt.IsZero() {
		return "", fmt.Errorf("GitHub App installation token response was incomplete")
	}
	s.token, s.expiresAt = result.Token, result.ExpiresAt
	return s.token, nil
}

func (s *installationTokenSource) signAppJWT(now time.Time) (string, error) {
	claims := jwt.RegisteredClaims{
		Issuer:    s.clientID,
		IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
		ExpiresAt: jwt.NewNumericDate(now.Add(9 * time.Minute)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(s.signingKey)
}
