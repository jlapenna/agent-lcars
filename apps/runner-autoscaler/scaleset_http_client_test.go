package main

import (
	"io"
	"log/slog"
	"net/http"
	"testing"
)

func TestConfigureScaleSetHTTP2(t *testing.T) {
	transport := &http.Transport{}

	h2Transport, err := configureScaleSetHTTP2(transport)
	if err != nil {
		t.Fatalf("configureScaleSetHTTP2() error = %v, want nil", err)
	}
	if h2Transport == nil {
		t.Fatal("configureScaleSetHTTP2() returned a nil *http2.Transport with a nil error")
	}
	if got, want := h2Transport.ReadIdleTimeout, scaleSetHTTP2ReadIdleTimeout; got != want {
		t.Errorf("ReadIdleTimeout = %v, want %v", got, want)
	}
	if got, want := h2Transport.PingTimeout, scaleSetHTTP2PingTimeout; got != want {
		t.Errorf("PingTimeout = %v, want %v", got, want)
	}
	// http2.ConfigureTransports registers its dial hook under "h2" so the
	// base *http.Transport dispatches TLS connections that negotiate HTTP/2
	// to it; a nil entry here would mean HTTP/2 (and our keepalive probing)
	// never actually takes effect for this transport.
	if transport.TLSNextProto["h2"] == nil {
		t.Error(`transport.TLSNextProto["h2"] is nil; HTTP/2 was not wired onto the base transport`)
	}
}

func TestNewScaleSetHTTPClient(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	client := newScaleSetHTTPClient(logger)

	if got, want := client.RetryMax, scaleSetRetryMax; got != want {
		t.Errorf("RetryMax = %d, want %d", got, want)
	}
	if got, want := client.RetryWaitMax, scaleSetRetryWaitMax; got != want {
		t.Errorf("RetryWaitMax = %v, want %v", got, want)
	}
	if client.Logger != interface{}(logger) {
		t.Error("Logger was not wired to the logger passed in")
	}
	if client.HTTPClient == nil {
		t.Fatal("HTTPClient is nil")
	}
	if got, want := client.HTTPClient.Timeout, scaleSetRequestTimeout; got != want {
		t.Errorf("HTTPClient.Timeout = %v, want %v", got, want)
	}

	transport, ok := client.HTTPClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("HTTPClient.Transport is a %T, want *http.Transport", client.HTTPClient.Transport)
	}
	if transport.TLSNextProto["h2"] == nil {
		t.Error(`HTTP/2 was not configured on the client's transport (TLSNextProto["h2"] is nil)`)
	}
}

func TestNewScaleSetHTTPClientNilLogger(t *testing.T) {
	// Every call site today always has a logger, but a nil argument must not
	// panic -- it should fall back to a discard logger like the rest of the
	// package's Logger() convention (config.go's default case).
	client := newScaleSetHTTPClient(nil)
	if client == nil {
		t.Fatal("newScaleSetHTTPClient(nil) returned nil")
	}
	if got, want := client.HTTPClient.Timeout, scaleSetRequestTimeout; got != want {
		t.Errorf("HTTPClient.Timeout = %v, want %v", got, want)
	}
}

func TestScaleSetHTTP2ReadIdleTimeoutUnderRequestTimeout(t *testing.T) {
	// If this ever inverted, a keepalive PING sent near the read-idle
	// boundary would have no room left to resolve (or fail) before the
	// overall request deadline fires, defeating the point of probing.
	if scaleSetHTTP2ReadIdleTimeout+scaleSetHTTP2PingTimeout >= scaleSetRequestTimeout {
		t.Errorf("ReadIdleTimeout(%v)+PingTimeout(%v) must stay under RequestTimeout(%v)",
			scaleSetHTTP2ReadIdleTimeout, scaleSetHTTP2PingTimeout, scaleSetRequestTimeout)
	}
}
