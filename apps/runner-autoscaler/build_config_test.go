package main

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

type nxProjectConfig struct {
	Targets map[string]struct {
		Executor string `json:"executor"`
		Options  struct {
			Flags []string `json:"flags"`
		} `json:"options"`
	} `json:"targets"`
}

// TestNxBuildConfigDisablesVCSStampingForLinkedWorktrees guards against a
// regression where `go build`, run from a git linked worktree (a `.git` file
// pointing at the primary checkout's `.git/worktrees/<name>` rather than a
// `.git` directory), fails or stamps bogus VCS info because the Go toolchain
// can't resolve the linked worktree's VCS metadata the way it expects to from
// a normal checkout. The fix is `-buildvcs=false` in the Nx build target's
// flags, which this test asserts is present.
//
// This test is intentionally config-assertion-only: it does not spawn git or
// go subprocesses to reproduce the linked-worktree scenario end-to-end. An
// earlier version of this test did exactly that (t.TempDir() git repo, `git
// init`/`config`/`add`/`commit`/`worktree add`, then a real `go build`), and
// it escaped its sandbox twice in the same session (see #328): once by
// committing throwaway fixture content onto a real feature branch from
// inside a pre-push hook, and separately by flipping the shared checkout's
// `core.bare` and user identity via a leaked GIT_DIR/GIT_WORK_TREE inherited
// from the invoking environment. Per maintainer policy (#328), unit tests
// must not execute real git commands at all -- clearing GIT_* env vars only
// narrows that escape, it doesn't remove the class of bug.
//
// The flag's runtime semantics (that -buildvcs=false actually makes `go
// build` succeed from a linked worktree) are stable upstream Go toolchain
// behavior, not something this repo needs to re-prove in a unit test -- and
// every real CI build already exercises it for real, since CI checks out and
// builds from linked worktrees using this exact Nx target.
func TestNxBuildConfigDisablesVCSStampingForLinkedWorktrees(t *testing.T) {
	projectJSON, err := os.ReadFile("project.json")
	if err != nil {
		t.Fatalf("read project.json: %v", err)
	}

	var project nxProjectConfig
	if err := json.Unmarshal(projectJSON, &project); err != nil {
		t.Fatalf("parse project.json: %v", err)
	}
	build, ok := project.Targets["build"]
	if !ok {
		t.Fatal("project.json must define the effective Nx build target explicitly")
	}
	if build.Executor != "@naxodev/gonx:build" {
		t.Fatalf("unexpected build executor %q", build.Executor)
	}
	if !slices.Contains(build.Options.Flags, "-buildvcs=false") {
		t.Fatalf("Nx build flags %v do not disable unreliable linked-worktree VCS stamping", build.Options.Flags)
	}
}
