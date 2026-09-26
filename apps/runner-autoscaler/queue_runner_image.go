package main

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	dockerclient "github.com/docker/docker/client"
)

// Registry freshness is independent of a claimed run. Existing images work
// during an outage; an actually missing image (including after prune) is pulled.
func ensureQueueRunnerImage(ctx context.Context, client *dockerclient.Client, host, image string, logger *slog.Logger) (string, error) {
	inspectCtx, cancel := context.WithTimeout(ctx, dockerInspectTimeout)
	_, err := client.ImageInspect(inspectCtx, image)
	cancel()
	if err == nil {
		return image, nil
	}
	if !cerrdefs.IsNotFound(err) {
		return "", fmt.Errorf("inspecting queue runner image on %q: %w", host, err)
	}
	return prepareRunnerImageForHost(ctx, client, host, image, logger)
}

const queueRunnerImageRefreshInterval = 5 * time.Minute

// Preserve follow-tag policy with bounded background refreshes. This loop does
// not claim work, remove cached images, or block the poller's placement path.
func refreshQueueRunnerImages(ctx context.Context, q queueExecutorResolved, newClient func(string) (*dockerclient.Client, error), logger *slog.Logger) {
	ticker := time.NewTicker(queueRunnerImageRefreshInterval)
	defer ticker.Stop()
	for {
		refreshQueueRunnerImagesOnce(ctx, q, newClient, logger)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func refreshQueueRunnerImagesOnce(ctx context.Context, q queueExecutorResolved, newClient func(string) (*dockerclient.Client, error), logger *slog.Logger) {
	var refreshes sync.WaitGroup
	defer refreshes.Wait()
	for _, host := range q.order {
		if ctx.Err() != nil {
			return
		}
		refreshes.Go(func() {
			client, err := newClient(q.targets[host])
			if err != nil {
				logger.Warn("Queue runner image refresh could not connect", slog.String("host", host))
				return
			}
			refreshCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			_, err = prepareRunnerImageForHost(refreshCtx, client, host, q.image, logger)
			cancel()
			_ = client.Close()
			if err != nil {
				logger.Warn("Queue runner image refresh failed; retaining cached image", slog.String("host", host), slog.String("error", err.Error()))
			}
		})
	}
}
