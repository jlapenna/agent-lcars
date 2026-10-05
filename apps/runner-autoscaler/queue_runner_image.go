package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	dockerclient "github.com/docker/docker/client"
)

// queueRunnerImageDigestTimeout bounds the registry manifest lookup a launch
// makes before using a cached image. It is deliberately short: an
// unreachable registry must cost a claimed run seconds, not the full pull
// deadline, before it falls back to the cached image.
const queueRunnerImageDigestTimeout = 10 * time.Second

// ensureQueueRunnerImage follows the configured mutable tag at launch time,
// the way a Kubernetes Job's PullAlways does: resolve the tag's registry
// digest and pull only when the cached image differs. This replaces a
// five-minute background refresh that pulled on every host whether or not the
// tag had moved; the tag only moves when a new runner image is promoted.
//
// Registry freshness never blocks a claimed run that has something runnable.
// A failed digest lookup or a failed pull keeps the cached image; only an
// actually missing image (including after prune) must be pulled.
func ensureQueueRunnerImage(ctx context.Context, client *dockerclient.Client, host, image string, logger *slog.Logger) (string, error) {
	inspectCtx, cancel := context.WithTimeout(ctx, dockerInspectTimeout)
	cached, err := client.ImageInspect(inspectCtx, image)
	cancel()
	if err != nil {
		if !cerrdefs.IsNotFound(err) {
			return "", fmt.Errorf("inspecting queue runner image on %q: %w", host, err)
		}
		return prepareRunnerImageForHost(ctx, client, host, image, logger)
	}

	lookupCtx, cancelLookup := context.WithTimeout(ctx, queueRunnerImageDigestTimeout)
	remote, err := client.DistributionInspect(lookupCtx, image, "")
	cancelLookup()
	if err != nil {
		logger.Warn("Could not resolve queue runner image tag; launching cached image",
			slog.String("host", host), slog.String("image", image), slog.String("error", err.Error()))
		return image, nil
	}
	want := remote.Descriptor.Digest.String()
	if want != "" && hasRepoDigest(cached.RepoDigests, want) {
		return image, nil
	}

	logger.Info("Queue runner image tag moved; pulling before launch",
		slog.String("host", host), slog.String("image", image), slog.String("digest", want))
	if _, err := prepareRunnerImageForHost(ctx, client, host, image, logger); err != nil {
		logger.Warn("Queue runner image pull failed; launching cached image",
			slog.String("host", host), slog.String("image", image), slog.String("error", err.Error()))
	}
	return image, nil
}

// hasRepoDigest reports whether any of an image's "repo@sha256:..." entries
// names digest.
func hasRepoDigest(repoDigests []string, digest string) bool {
	for _, repoDigest := range repoDigests {
		if strings.HasSuffix(repoDigest, "@"+digest) {
			return true
		}
	}
	return false
}
