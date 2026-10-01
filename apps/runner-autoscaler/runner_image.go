package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
)

// prepareRunnerImageForHost refreshes the configured mutable runner-image tag
// before every placement, so a host always follows the registry's tip of tree.
func prepareRunnerImageForHost(ctx context.Context, client *dockerclient.Client, host, runnerImage string, logger *slog.Logger) (string, error) {
	logger.Info("Refreshing runner image on selected host",
		slog.String("host", host), slog.String("image", runnerImage))
	if err := pullRunnerImage(ctx, client, runnerImage, host); err != nil {
		return "", err
	}
	logDigests(ctx, logger, DockerHost{Name: host, Client: client}, runnerImage)
	return runnerImage, nil
}

// pullRunnerImage establishes the exact runner image on one host. Mutable
// tags are deliberately pulled even when cached, and Docker's streamed
// progress is decoded because registry/auth failures are reported in that
// stream with a successful ImagePull HTTP response.
func pullRunnerImage(ctx context.Context, client *dockerclient.Client, runnerImage, host string) error {
	// Keep the deadline alive while consuming the response: Docker can accept
	// ImagePull and then wedge part-way through the progress stream.
	pullCtx, cancelPull := context.WithTimeout(ctx, dockerImagePullTimeout)
	defer cancelPull()
	pull, err := client.ImagePull(pullCtx, runnerImage, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("failed to pull runner image %q on host %q: %w", runnerImage, host, err)
	}
	defer func() { _ = pull.Close() }()
	// Docker streams pull progress as newline-delimited JSON and reports
	// registry/auth/manifest failures INSIDE that stream -- ImagePull itself
	// returns a nil error for them. Discarding the body would swallow that,
	// and because a refreshed TAG is normally already present locally, the
	// ImageInspect below would then succeed against the STALE image and this
	// function would return nil. That is exactly the bug #139 exists to fix,
	// reintroduced one layer down: before this change the pull only ran when
	// the image was ABSENT, so a failed pull surfaced as a failed inspect.
	dec := json.NewDecoder(pull)
	for {
		var msg struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if decErr := dec.Decode(&msg); errors.Is(decErr, io.EOF) {
			break
		} else if decErr != nil {
			return fmt.Errorf("failed while reading pull progress for runner image %q on host %q: %w", runnerImage, host, decErr)
		}
		if detail := msg.Error; detail != "" {
			return fmt.Errorf("pull of runner image %q on host %q failed: %s", runnerImage, host, detail)
		}
		if detail := msg.ErrorDetail.Message; detail != "" {
			return fmt.Errorf("pull of runner image %q on host %q failed: %s", runnerImage, host, detail)
		}
	}
	inspectCtx, cancelInspect := context.WithTimeout(ctx, dockerInspectTimeout)
	_, err = client.ImageInspect(inspectCtx, runnerImage)
	cancelInspect()
	if err != nil {
		return fmt.Errorf("runner image %q is still unavailable on host %q after pull: %w", runnerImage, host, err)
	}
	return nil
}

// logDigests records the content-addressable digest(s) actually resolved
// for runnerImage on host after a pull, for audit purposes. Image pulls are
// tag-only trust (see agent-lcars#96/#101) -- this doesn't prevent a
// registry from silently serving different content under the same tag, but
// it leaves a trail that lets a compromise be detected/investigated after
// the fact by diffing digests across pulls, which today's logs don't
// capture at all.
func logDigests(ctx context.Context, logger *slog.Logger, host DockerHost, runnerImage string) {
	inspectCtx, cancel := context.WithTimeout(ctx, dockerInspectTimeout)
	defer cancel()
	inspect, err := host.Client.ImageInspect(inspectCtx, runnerImage)
	if err != nil {
		logger.Warn("Pulled runner image but could not inspect it for a digest", slog.String("host", host.Name), slog.String("image", runnerImage), slog.String("error", err.Error()))
		return
	}
	logger.Info("Pulled runner image", slog.String("host", host.Name), slog.String("image", runnerImage), slog.Any("digests", inspect.RepoDigests))
}
