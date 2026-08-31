package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
	"github.com/google/uuid"
)

const directRunnerPreflightLabelKey = "agent-lcars.direct-runner-preflight"

// directRunnerPermanentCredentialMounts describes the host files every
// eligible direct-executor host must be able to bind and read. The telemetry
// writer is common to every adapter; provider material is collected through
// the same adapter registry launchDirectRunner uses. Codex contributes no
// host credential by design.
func directRunnerPermanentCredentialMounts() ([]directRunnerCredentialMount, error) {
	writerPath, err := directRunnerTelemetryWriterHostPath()
	if err != nil {
		return nil, err
	}
	mounts := []directRunnerCredentialMount{{
		hostPath:      writerPath,
		containerPath: directRunnerTelemetryWriterMountPath,
	}}
	for _, adapter := range directRunnerAdapters {
		adapterMounts, err := adapter.credentialMounts()
		if err != nil {
			return nil, fmt.Errorf("%s adapter: %w", adapter.pipeline, err)
		}
		mounts = append(mounts, adapterMounts...)
	}
	return mounts, nil
}

// directRunnerPreflightHosts probes every configured Docker host using a
// short-lived container. A host that cannot create, start, or successfully
// read the permanent bind sources is excluded from the queue's immutable
// launch pool. This lets optional/offline hosts remain configured for the
// GitHub runner fleet without ever receiving a direct queue claim.
func directRunnerPreflightHosts(ctx context.Context, resolved resolvedOrchestratorConfig, newClient func(string) (*dockerclient.Client, error), logger *slog.Logger) (resolvedOrchestratorConfig, error) {
	mounts, err := directRunnerPermanentCredentialMounts()
	if err != nil {
		return resolvedOrchestratorConfig{}, err
	}
	images := directRunnerPreflightImages()
	targets, order, err := ParseDockerHosts(resolved.DockerHosts)
	if err != nil {
		return resolvedOrchestratorConfig{}, err
	}

	eligible := make([]string, 0, len(order))
	for _, host := range order {
		if err := directRunnerPreflightHostImages(ctx, newClient, host, targets[host], images, mounts, logger); err != nil {
			logger.Warn("Direct queue host is ineligible; excluding it from queue launch", slog.String("host", host), slog.String("error", err.Error()))
			continue
		}
		eligible = append(eligible, host+"="+targets[host])
	}
	if len(eligible) == 0 {
		return resolvedOrchestratorConfig{}, fmt.Errorf("no configured Docker host passed the direct-runner credential preflight")
	}
	queueResolved := resolved
	queueResolved.DockerHosts = eligible
	return queueResolved, nil
}

// directRunnerPreflightImages returns the one direct-runner image that every
// provider uses after claim. GitHub scale-set configuration is unrelated to
// QueueExecutor placement.
func directRunnerPreflightImages() []string {
	return []string{directRunnerImage()}
}

func directRunnerPreflightHostImages(ctx context.Context, newClient func(string) (*dockerclient.Client, error), host, target string, images []string, mounts []directRunnerCredentialMount, logger *slog.Logger) error {
	for _, image := range images {
		if err := directRunnerPreflightHost(ctx, newClient, host, target, image, mounts, logger); err != nil {
			return fmt.Errorf("image %q: %w", image, err)
		}
	}
	return nil
}

// directRunnerPreflightHost creates one disposable container with all
// permanent credentials mounted and runs a fixed, path-only readability
// check as the same `runner` user used by direct work. The container is always
// force-removed after create, including a failed start, wait timeout, or a
// non-zero check result, so the readiness check never leaves host artifacts.
func directRunnerPreflightHost(ctx context.Context, newClient func(string) (*dockerclient.Client, error), host, target, runnerImage string, mounts []directRunnerCredentialMount, logger *slog.Logger) (err error) {
	client, err := newClient(target)
	if err != nil {
		return fmt.Errorf("connecting: %w", err)
	}
	defer client.Close()
	// The normal startup warmer runs asynchronously. Establish the selected
	// mutable image here as part of this host's admission probe instead of
	// racing its background pull on a fresh host. A host with a failed pull is
	// excluded before it can claim any provider's work.
	preparedImage, err := prepareRunnerImageForHost(ctx, client, host, runnerImage, logger)
	if err != nil {
		return err
	}

	binds := make([]string, 0, len(mounts))
	paths := make([]string, 0, len(mounts))
	for _, mount := range mounts {
		binds = append(binds, mount.bind())
		paths = append(paths, mount.containerPath)
	}
	createCtx, cancelCreate := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	created, err := client.ContainerCreate(createCtx, &container.Config{
		Image:       preparedImage,
		User:        "runner",
		Entrypoint:  []string{"/bin/sh"},
		Cmd:         append([]string{"-ec", "for path do test -f \"$path\" && test -r \"$path\" || exit 1; done", "--"}, paths...),
		Labels:      map[string]string{directRunnerPreflightLabelKey: "1"},
		WorkingDir:  "/",
		AttachStdin: false,
	}, &container.HostConfig{
		Binds:          binds,
		NetworkMode:    "none",
		ReadonlyRootfs: true,
	}, nil, nil, "direct-runner-preflight-"+uuid.NewString()[:8])
	cancelCreate()
	if err != nil {
		return fmt.Errorf("host %q: creating credential preflight container: %w", host, err)
	}
	defer func() {
		removeCtx, cancelRemove := context.WithTimeout(context.WithoutCancel(ctx), dockerContainerOperationTimeout)
		removeErr := client.ContainerRemove(removeCtx, created.ID, container.RemoveOptions{Force: true})
		cancelRemove()
		if removeErr != nil {
			err = errors.Join(err, fmt.Errorf("host %q: removing credential preflight container: %w", host, removeErr))
		}
	}()

	startCtx, cancelStart := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	if startErr := client.ContainerStart(startCtx, created.ID, container.StartOptions{}); startErr != nil {
		cancelStart()
		return fmt.Errorf("host %q: starting credential preflight container: %w", host, startErr)
	}
	cancelStart()

	waitCtx, cancelWait := context.WithTimeout(ctx, directRunnerPreflightWaitTimeout)
	defer cancelWait()
	statusCh, errCh := client.ContainerWait(waitCtx, created.ID, container.WaitConditionNotRunning)
	for statusCh != nil || errCh != nil {
		select {
		case status, ok := <-statusCh:
			if !ok {
				statusCh = nil
				continue
			}
			if status.StatusCode != 0 {
				return fmt.Errorf("host %q: credential preflight reported unreadable or missing bind source (exit %d)", host, status.StatusCode)
			}
			return nil
		case waitErr, ok := <-errCh:
			if !ok {
				errCh = nil
				continue
			}
			if waitErr != nil {
				return fmt.Errorf("host %q: waiting for credential preflight container: %w", host, waitErr)
			}
		}
	}
	return fmt.Errorf("host %q: credential preflight wait ended without a result", host)
}
