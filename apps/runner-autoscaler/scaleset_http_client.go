package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/hashicorp/go-retryablehttp"
	"golang.org/x/net/http2"
)

// The github.com/actions/scaleset listener's GetMessage long poll blocks on
// the GitHub Actions broker (broker.actions.githubusercontent.com) for up to
// ~50s server-side before returning. actions/scaleset#105 (tracking
// actions-runner-controller#3682) documents a proven failure mode against
// that same broker: an HTTP/2 connection goes dead -- no RST, no FIN, no TCP
// timeout, the OS believes it is still open -- and every subsequent call
// that happens to reuse it blocks for 15-20 minutes before the runtime's own
// keepalive machinery finally notices and recycles it. That is on the order
// of agent-lcars#1716's stranded-queue symptom: a listener that looks
// healthy in the process table but has stopped receiving messages. The fix
// upstream proposes, and the one applied here at the injection point the
// library already exposes (scaleset.WithRetryableHTTPClint), is an HTTP/2
// transport configured to probe idle connections with keepalive PINGs and a
// bounded per-request timeout so a stuck call fails fast into
// retryablehttp's own retry/backoff instead of hanging indefinitely.
const (
	// scaleSetHTTP2ReadIdleTimeout is how long an HTTP/2 connection may sit
	// with no frames at all (no traffic in either direction) before the
	// transport sends a keepalive PING to check it is still alive. It must
	// stay comfortably under scaleSetRequestTimeout so a PING has time to
	// resolve (or time out) before the overall request deadline fires, and
	// short enough that a dead connection is caught well inside one
	// long-poll cycle rather than surviving to the next one.
	scaleSetHTTP2ReadIdleTimeout = 30 * time.Second
	// scaleSetHTTP2PingTimeout bounds how long the transport waits for a
	// reply to that keepalive PING before declaring the connection dead and
	// tearing it down for a fresh dial on the next request.
	scaleSetHTTP2PingTimeout = 15 * time.Second
	// scaleSetRequestTimeout bounds every request the client makes,
	// including the listener's long poll. The broker's own poll window is
	// documented at ~50s; 90s gives that generous margin (covering scheduling
	// jitter and the keepalive probe above resolving mid-request) while still
	// failing a genuinely wedged call in well under the 15-20 minute hangs
	// actions/scaleset#105 reports from an undetected dead connection.
	scaleSetRequestTimeout = 90 * time.Second
	// scaleSetRetryMax/scaleSetRetryWaitMax bound retryablehttp's own
	// retry/backoff for transient failures (a timed-out or reset request
	// included). These are set directly on the *retryablehttp.Client built
	// here rather than via the library's scaleset.WithRetryMax /
	// scaleset.WithRetryWaitMax HTTPOptions: per common_client.go, those
	// options are ignored whenever a custom retryable client is supplied
	// through scaleset.WithRetryableHTTPClint, which this file always does.
	scaleSetRetryMax     = 4
	scaleSetRetryWaitMax = 30 * time.Second
)

// configureScaleSetHTTP2 enables HTTP/2 keepalive probing on t. It is
// factored out of newScaleSetHTTPClient so a test can inspect the
// *http2.Transport that http2.ConfigureTransports produces -- once
// registered, that Transport lives only inside t's private TLSNextProto
// dial hook and isn't otherwise reachable from t.
func configureScaleSetHTTP2(t *http.Transport) (*http2.Transport, error) {
	h2Transport, err := http2.ConfigureTransports(t)
	if err != nil {
		return nil, fmt.Errorf("failed to configure HTTP/2 transport: %w", err)
	}
	h2Transport.ReadIdleTimeout = scaleSetHTTP2ReadIdleTimeout
	h2Transport.PingTimeout = scaleSetHTTP2PingTimeout
	return h2Transport, nil
}

// newScaleSetHTTPClient builds the retryablehttp.Client injected into the
// scaleset library's Client and, transitively, every MessageSessionClient it
// creates (Client.MessageSessionClient copies the option that carries this
// client and reuses the same *retryablehttp.Client instance, so the listener's
// long poll shares this hardened transport rather than getting a fresh
// unconfigured one). See the package-level comment above for why.
func newScaleSetHTTPClient(logger *slog.Logger) *retryablehttp.Client {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	client := retryablehttp.NewClient()
	client.Logger = logger
	client.RetryMax = scaleSetRetryMax
	client.RetryWaitMax = scaleSetRetryWaitMax
	client.HTTPClient.Timeout = scaleSetRequestTimeout

	transport, ok := client.HTTPClient.Transport.(*http.Transport)
	if !ok {
		// retryablehttp.NewClient() always builds its transport from
		// cleanhttp.DefaultPooledTransport(), which returns *http.Transport;
		// this branch is a defensive fallback against an upstream change
		// swapping that out, not a path expected to run today.
		logger.Warn("scaleset retryablehttp client transport is not *http.Transport; HTTP/2 keepalive probing not configured",
			slog.String("transport_type", fmt.Sprintf("%T", client.HTTPClient.Transport)))
		return client
	}

	if _, err := configureScaleSetHTTP2(transport); err != nil {
		logger.Warn("failed to configure HTTP/2 keepalive probing for the scaleset transport; a dead broker connection may go undetected (see actions/scaleset#105)",
			slog.Any("error", err))
	}

	return client
}
