package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
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

func TestNxBuildWorksFromLinkedWorktree(t *testing.T) {
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

	root := t.TempDir()
	primary := filepath.Join(root, "primary")
	linked := filepath.Join(root, "linked")
	mustRun(t, root, "git", "init", "--initial-branch=main", primary)
	mustRun(t, primary, "git", "config", "user.name", "Agent LCARS test")
	mustRun(t, primary, "git", "config", "user.email", "agent-lcars-test@example.invalid")
	mustWriteFile(t, filepath.Join(primary, "go.mod"), "module example.invalid/linked-worktree\n\ngo 1.26\n")
	mustWriteFile(t, filepath.Join(primary, "main.go"), "package main\n\nfunc main() {}\n")
	mustRun(t, primary, "git", "add", "go.mod", "main.go")
	mustRun(t, primary, "git", "commit", "-m", "fixture")
	mustRun(t, primary, "git", "worktree", "add", "-b", "fixture-linked", linked)

	gitFile, err := os.Stat(filepath.Join(linked, ".git"))
	if err != nil {
		t.Fatalf("stat linked-worktree .git file: %v", err)
	}
	if !gitFile.Mode().IsRegular() {
		t.Fatalf("expected linked-worktree .git to be a file, mode is %v", gitFile.Mode())
	}

	output := filepath.Join(root, "linked-worktree-binary")
	args := append([]string{"build"}, build.Options.Flags...)
	args = append(args, "-o", output, ".")
	mustRun(t, linked, "go", args...)
	if _, err := os.Stat(output); err != nil {
		t.Fatalf("effective Nx build flags did not produce a binary: %v", err)
	}
}

func mustWriteFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustRun(t *testing.T, dir, name string, args ...string) {
	t.Helper()
	command := exec.Command(name, args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s failed: %v\n%s", name, strings.Join(args, " "), err, output)
	}
}
