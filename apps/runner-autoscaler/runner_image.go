package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	dockerclient "github.com/docker/docker/client"
)

var (
	directHTTP5xxStatusPattern = regexp.MustCompile(`(?i)\bstatus(?:\s+code)?\s*(?::|=)?\s*5[0-9]{2}\b`)
	dockerHTTP5xxStatusPattern = regexp.MustCompile(`(?i)\bstatus\s+from\s+\S+\s+request(?:\s+to\s+\S+)?:\s*5[0-9]{2}(?:\s|$)`)
)

type runnerImageSpec struct {
	primary  string
	fallback string
	pool     string
}

func imageRepository(ref string) string {
	ref = strings.TrimSpace(ref)
	if at := strings.LastIndex(ref, "@"); at >= 0 {
		ref = ref[:at]
	}
	if colon, slash := strings.LastIndex(ref, ":"), strings.LastIndex(ref, "/"); colon > slash {
		ref = ref[:colon]
	}
	return ref
}

func isSHA256DigestRef(ref string) bool {
	const marker = "@sha256:"
	at := strings.LastIndex(ref, marker)
	if at < 1 || at+len(marker)+64 != len(ref) {
		return false
	}
	_, err := hex.DecodeString(ref[at+len(marker):])
	return err == nil
}

func validateRunnerImageFallback(primary, fallback string) error {
	if fallback == "" {
		return nil
	}
	if isDigestRef(primary) {
		return fmt.Errorf("runner_image_fallback requires a mutable primary runner_image tag")
	}
	if !isSHA256DigestRef(fallback) {
		return fmt.Errorf("runner_image_fallback %q must be an immutable name@sha256:<64 hex> reference", fallback)
	}
	if imageRepository(primary) != imageRepository(fallback) {
		return fmt.Errorf("runner_image_fallback repository %q does not match runner_image repository %q", imageRepository(fallback), imageRepository(primary))
	}
	return nil
}

func registryUnavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return true
	}
	message := strings.ToLower(err.Error())
	if directHTTP5xxStatusPattern.MatchString(message) || dockerHTTP5xxStatusPattern.MatchString(message) {
		return true
	}
	for statusCode := 500; statusCode <= 599; statusCode++ {
		statusText := strings.ToLower(http.StatusText(statusCode))
		if statusText != "" && strings.Contains(message, fmt.Sprintf("%d %s", statusCode, statusText)) {
			return true
		}
	}
	for _, marker := range []string{
		"connection refused",
		"connection reset by peer",
		"no route to host",
		"network is unreachable",
		"i/o timeout",
		"tls handshake timeout",
		"temporary failure in name resolution",
		"no such host",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// resolveRunnerImageForHost keeps mutable tags authoritative while the
// registry is healthy. Only an explicitly configured, same-repository digest
// may satisfy a placement during a registry availability failure, and only
// when that exact digest is already cached on the selected host.
func resolveRunnerImageForHost(ctx context.Context, client *dockerclient.Client, host string, spec runnerImageSpec, logger *slog.Logger) (string, error) {
	if isDigestRef(spec.primary) {
		inspectCtx, cancelInspect := context.WithTimeout(ctx, dockerInspectTimeout)
		_, err := client.ImageInspect(inspectCtx, spec.primary)
		cancelInspect()
		if err == nil {
			runnerImageFallbackActive.WithLabelValues(spec.pool, host).Set(0)
			return spec.primary, nil
		}
		if !cerrdefs.IsNotFound(err) {
			return "", fmt.Errorf("failed to inspect runner image %q on host %q: %w", spec.primary, host, err)
		}
	}

	logger.Info("Refreshing runner image on selected host",
		slog.String("host", host), slog.String("image", spec.primary))
	primaryErr := pullRunnerImage(ctx, client, spec.primary, host)
	if primaryErr == nil {
		runnerImageFallbackActive.WithLabelValues(spec.pool, host).Set(0)
		logDigests(ctx, logger, DockerHost{Name: host, Client: client}, spec.primary)
		return spec.primary, nil
	}
	if spec.fallback == "" || !registryUnavailable(primaryErr) {
		return "", primaryErr
	}

	inspectCtx, cancelInspect := context.WithTimeout(ctx, dockerInspectTimeout)
	_, fallbackErr := client.ImageInspect(inspectCtx, spec.fallback)
	cancelInspect()
	if fallbackErr != nil {
		return "", fmt.Errorf("%w; configured fallback %q is not cached on host %q: %v", primaryErr, spec.fallback, host, fallbackErr)
	}

	runnerImageFallbackActive.WithLabelValues(spec.pool, host).Set(1)
	runnerImageFallbackUses.WithLabelValues(spec.pool, host).Inc()
	logger.Warn("Registry unavailable; using configured cached runner image fallback",
		slog.String("host", host),
		slog.String("image", spec.primary),
		slog.String("fallback", spec.fallback),
		slog.String("error", primaryErr.Error()))
	return spec.fallback, nil
}
