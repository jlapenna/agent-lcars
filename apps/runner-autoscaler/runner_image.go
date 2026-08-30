package main

import (
	"context"
	"log/slog"

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
