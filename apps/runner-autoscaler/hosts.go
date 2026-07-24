package main

import (
	"fmt"
	"strings"

	"github.com/docker/cli/cli/connhelper"
	dockerclient "github.com/docker/docker/client"
)

// DockerHost is one fleet member the scaler can place runners on.
type DockerHost struct {
	Name   string
	Client *dockerclient.Client
}

// ParseDockerHosts parses `--docker-hosts` entries of the form
// "name=target", where target is "local" (the mounted socket, via
// DOCKER_HOST/env) or "ssh://user@host" (proxied over the existing fleet SSH
// key — no Docker TCP port is ever exposed). Order is preserved; it becomes
// the round-robin base order in newDockerHostPool.
func ParseDockerHosts(entries []string) (map[string]string, []string, error) {
	targets := make(map[string]string, len(entries))
	var order []string
	for _, e := range entries {
		name, target, ok := strings.Cut(e, "=")
		name, target = strings.TrimSpace(name), strings.TrimSpace(target)
		if !ok || name == "" || target == "" {
			return nil, nil, fmt.Errorf("invalid --docker-hosts entry %q, want name=target", e)
		}
		if _, dup := targets[name]; dup {
			return nil, nil, fmt.Errorf("duplicate --docker-hosts name %q", name)
		}
		targets[name] = target
		order = append(order, name)
	}
	return targets, order, nil
}

// Fixed in-container paths for the fleet SSH identity, mounted read-only by
// docker-compose.yml from ansible/ssh_key/id_ed25519 (the same automation key
// sync_keys.yml authorizes on every host — see ansible/inventory.yml) and a
// known_hosts pre-populated by ssh-keyscan (see README "Fleet SSH access") so
// remote connections pin host keys instead of trusting-on-first-use.
const (
	fleetSSHKeyPath     = "/secrets/fleet-ssh-key"
	fleetKnownHostsPath = "/secrets/known_hosts"
)

// newDockerClient builds a client for one target: "local" uses the ambient
// DOCKER_HOST/socket (dockerclient.FromEnv); "ssh://..." proxies the remote
// daemon's socket over SSH using the same connection helper `docker context`
// uses internally (shells out to the real `ssh` binary), so no remote Docker
// API port is ever opened — pinned to the fleet automation key + known_hosts.
func newDockerClient(target string) (*dockerclient.Client, error) {
	if target == "local" {
		return dockerclient.NewClientWithOpts(dockerclient.FromEnv, dockerclient.WithAPIVersionNegotiation())
	}

	sshOpts := []string{
		"-i", fleetSSHKeyPath,
		"-o", "IdentitiesOnly=yes",
		"-o", "UserKnownHostsFile=" + fleetKnownHostsPath,
		"-o", "StrictHostKeyChecking=yes",
		// Do not use ControlMaster/ControlPersist here. Persist daemonizes a
		// background ssh master which becomes the autoscaler's child but is
		// outside exec.Cmd's lifecycle, recreating the zombie leak even when
		// every foreground command is Waited correctly.
		"-o", "ControlMaster=no",
		// Bound connection setup: without this, a black-holing fleet host
		// (down but not refusing connections) stalls image pulls/inspects
		// for the kernel TCP timeout (minutes) instead of failing fast.
		"-o", "ConnectTimeout=10",
	}
	helper, err := connhelper.GetConnectionHelperWithSSHOpts(target, sshOpts)
	if err != nil {
		return nil, fmt.Errorf("ssh docker target %q: %w", target, err)
	}
	return dockerclient.NewClientWithOpts(
		dockerclient.WithHost(helper.Host),
		dockerclient.WithDialContext(helper.Dialer),
		dockerclient.WithAPIVersionNegotiation(),
	)
}

// newDockerHostPool connects to every configured host up front (fail fast on
// a bad SSH target rather than discovering it mid-scale-up).
func newDockerHostPool(entries []string) ([]DockerHost, error) {
	targets, order, err := ParseDockerHosts(entries)
	if err != nil {
		return nil, err
	}
	hosts := make([]DockerHost, 0, len(order))
	for _, name := range order {
		c, err := newDockerClient(targets[name])
		if err != nil {
			return nil, fmt.Errorf("connecting to docker host %q (%s): %w", name, targets[name], err)
		}
		hosts = append(hosts, DockerHost{Name: name, Client: c})
	}
	return hosts, nil
}
