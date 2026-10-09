package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

type queueTokenTransport func(*http.Request) (*http.Response, error)

func (f queueTokenTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestQueueClaimStatusCancelsActualTokenRefresh(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(map[string]string{"type": "service_account", "client_email": "fixture@example.invalid", "private_key_id": "fixture", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), "token_uri": "https://fixture.invalid/token"})
	if err != nil {
		t.Fatal(err)
	}
	file := t.TempDir() + "/fixture.json"
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	entered, exited := make(chan time.Time, 1), make(chan struct{}, 1)
	var requests atomic.Int32
	transport := queueTokenTransport(func(r *http.Request) (*http.Response, error) {
		if requests.Add(1) == 1 {
			token := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1}`)) + ".fixture"
			body, _ := json.Marshal(map[string]string{"id_token": token})
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body))), Request: r}, nil
		}
		deadline, _ := r.Context().Deadline()
		entered <- deadline
		<-r.Context().Done()
		exited <- struct{}{}
		return nil, r.Context().Err()
	})
	// Preserve the supported injected transport and bound a client with no
	// timeout. Exercise the real JWT/refresh/cache entirely without network.
	client := &http.Client{Transport: transport}
	sourceCtx, stopSource := context.WithCancel(context.Background())
	defer stopSource()
	source, err := newDirectRunnerIDTokenSource(context.WithValue(sourceCtx, oauth2.HTTPClient, client), file, "agent-lcars-work")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	status := queueClaimStatus("https://status.invalid", func() (string, error) { return idTokenFromSource(source) })
	done := make(chan error, 1)
	go func() {
		_, err := status(ctx, "work:fixture/r1", "executor", queueClaimFingerprint("token"))
		done <- err
	}()
	select {
	case deadline := <-entered:
		if deadline.IsZero() || time.Until(deadline) > 10*time.Second {
			t.Fatal("actual refresh lacks its finite HTTP deadline")
		}
	case <-time.After(time.Second):
		t.Fatal("refresh fixture was not reached")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled identity acquisition accepted")
		}
	case <-time.After(50 * time.Millisecond):
		t.Fatal("sweep waited for underlying refresh")
	}
	stopSource()
	select {
	case <-exited:
	case <-time.After(11 * time.Second):
		t.Fatal("underlying refresh outlived its ten-second HTTP bound")
	}
	if client.Timeout != 0 {
		t.Fatal("caller HTTP client was mutated")
	}
}

func TestQueueClaimTokenAcquisitionSharesOutstandingWork(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	var calls atomic.Int32
	acquire := queueClaimTokenAcquisition(func() (string, error) { calls.Add(1); close(started); <-release; return "fixture", nil })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := acquire(ctx); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled acquisition succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation waited for callback")
	}
	for range 25 {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := acquire(ctx); done <- err }()
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("canceled sweep blocked")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("canceled sweeps accumulated token callbacks")
	}
}
