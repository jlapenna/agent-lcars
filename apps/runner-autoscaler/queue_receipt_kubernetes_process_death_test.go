//go:build kubernetes_integration

// Opt-in cross-process substrate for the capacity-receipt controller process-death
// matrix. This file is the process-and-identity half that a fake can never
// imitate: the parent test execs THIS SAME test binary as an independent child,
// drives it onto a control pipe, then SIGKILLs it and proves through Wait that
// the only way it stopped was a real SIGKILL -- not a graceful exit, a canceled
// context, or a goroutine failure -- and that a brand-new child carries a brand-new
// producer identity that never revives the dead one's.
//
// Scope, stated rather than hidden: this slice establishes the actual-death and
// identity-isolation invariants and the child's refusal to act before the parent
// binds it. It does NOT yet assert a durable Kubernetes Job/Secret surviving the
// kill, nor run the production reconcileReceipts on a successor; those require the
// real launch transport and are Root's gated exact-cluster run, not something this
// author Job can execute. Nothing here runs provider, bootstrap or session work.
//
// It is inert unless LCARS_RECEIPT_K8S_DEATH_ENABLED=1 is set, so neither ordinary
// nor the tagged compile-only run is affected.
//
//	LCARS_RECEIPT_K8S_DEATH_ENABLED=1 go test -tags=kubernetes_integration \
//	  -run '^TestReceiptKubernetesControllerProcessDeath$' -count=1 -timeout=420s ./apps/runner-autoscaler
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const (
	deathEnabledEnv    = "LCARS_RECEIPT_K8S_DEATH_ENABLED"
	deathControlFDEnv  = "LCARS_RECEIPT_K8S_DEATH_CONTROL_FD"
	deathCheckpointEnv = "LCARS_RECEIPT_K8S_DEATH_CHECKPOINT"
	deathInvocationEnv = "LCARS_RECEIPT_K8S_DEATH_INVOCATION"
	deathChildRun      = "^TestReceiptKubernetesControllerProcessDeathChild$"

	deathCaseHold    = "hold"    // child blocks after arming; parent must SIGKILL it
	deathCaseSuccess = "success" // child exits cleanly; parent must observe success

	deathFrameLimit = 1 << 20
)

// deathHandshake is the only cross-process frame: it never carries a run token,
// bearer, JWT, kubeconfig or environment. A producer identity is a random hex id.
type deathHandshake struct {
	Checkpoint string `json:"checkpoint"`
	ProducerID string `json:"producerId"`
	Invocation string `json:"invocation"`
}

// boundedWriter caps an untrusted child stream so a runaway child cannot pin the
// parent's memory; overflow is counted, never retained.
type boundedWriter struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	over int
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if remain := deathFrameLimit - w.buf.Len(); remain > 0 {
		if len(p) > remain {
			w.buf.Write(p[:remain])
			w.over += len(p) - remain
		} else {
			w.buf.Write(p)
		}
		return len(p), nil
	}
	w.over += len(p)
	return len(p), nil
}

func (w *boundedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func (w *boundedWriter) overflowed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.over > 0
}

func waitStatus(ps *os.ProcessState) (syscall.WaitStatus, bool) {
	if ps == nil {
		return syscall.WaitStatus(0), false
	}
	ws, ok := ps.Sys().(syscall.WaitStatus)
	return ws, ok
}

func writeDeathHandshake(f *os.File, h deathHandshake) error {
	body, err := json.Marshal(h)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	// A pipe has no write deadline; the single small frame fits the 64KiB buffer,
	// so a blocking write can only mean the parent stopped reading, which the
	// parent's own handshake read deadline already bounds.
	_, err = f.Write(body)
	return err
}

func readDeathHandshake(r *bufio.Reader, within time.Duration) (deathHandshake, error) {
	type res struct {
		h   deathHandshake
		err error
	}
	ch := make(chan res, 1)
	go func() {
		line, err := r.ReadBytes('\n')
		if err != nil {
			ch <- res{err: err}
			return
		}
		if len(line) > deathFrameLimit {
			ch <- res{err: fmt.Errorf("control frame exceeds %d bytes", deathFrameLimit)}
			return
		}
		var h deathHandshake
		if err := json.Unmarshal(bytes.TrimSpace(line), &h); err != nil {
			ch <- res{err: fmt.Errorf("control frame undecodable: %w", err)}
			return
		}
		ch <- res{h: h}
	}()
	select {
	case x := <-ch:
		return x.h, x.err
	case <-time.After(within):
		return deathHandshake{}, fmt.Errorf("no control frame within %s", within)
	}
}

// TestReceiptKubernetesControllerProcessDeathChild is the child role. Directly
// invoked (no parent control binding) it refuses and skips before doing any work;
// bound by the parent it announces a fresh identity then either blocks (for a
// death case the parent must kill) or exits cleanly.
func TestReceiptKubernetesControllerProcessDeathChild(t *testing.T) {
	fdRaw, checkpoint, invocation := os.Getenv(deathControlFDEnv), os.Getenv(deathCheckpointEnv), os.Getenv(deathInvocationEnv)
	if fdRaw == "" || checkpoint == "" || invocation == "" {
		t.Skip("controller-process-death child invoked without a parent control binding; refusing any action")
	}
	var fd int
	if _, err := fmt.Sscanf(fdRaw, "%d", &fd); err != nil || fd <= 2 {
		t.Fatalf("child control descriptor %q is not a usable inherited fd", fdRaw)
	}
	ctrl := os.NewFile(uintptr(fd), "receipt-death-control")
	if ctrl == nil {
		t.Fatalf("child cannot reopen inherited control descriptor %d", fd)
	}
	defer ctrl.Close()
	// Each incarnation mints its own identity; it never reuses another process's.
	if err := writeDeathHandshake(ctrl, deathHandshake{Checkpoint: checkpoint, ProducerID: newCapacityIdentity(), Invocation: invocation}); err != nil {
		t.Fatalf("child cannot announce its fresh identity: %v", err)
	}
	if checkpoint == deathCaseSuccess {
		return
	}
	// A death case: withhold, then block. The only permitted exit is the parent's
	// SIGKILL -- no graceful return, no context cancel, no panic.
	select {}
}

// TestReceiptKubernetesControllerProcessDeath owns every child, its cleanup, and
// the parent's own continued liveness. It never mutates Kubernetes and never
// requires a target: it is the process/identity invariant gate for the matrix.
func TestReceiptKubernetesControllerProcessDeath(t *testing.T) {
	if os.Getenv(deathEnabledEnv) != "1" {
		t.Skipf("controller-process-death matrix is opt-in; set %s=1 to activate", deathEnabledEnv)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolving this test executable for the child role: %v", err)
	}
	fi, err := os.Stat(exe)
	if err != nil || fi.IsDir() {
		t.Fatalf("child role requires the same executable to be runnable: %v", err)
	}
	var invocation [16]byte
	if _, err := rand.Read(invocation[:]); err != nil {
		t.Fatalf("creating a fresh suite identity: %v", err)
	}
	inv := fmt.Sprintf("%x", invocation)

	// Baseline: a child that reports success must exit on its own, un-killed.
	producerSuccess := runDeathChild(t, exe, inv, deathCaseSuccess, false)
	if producerSuccess == "" {
		t.Fatal("baseline child never announced a producer identity")
	}

	// Each death case must reach the armed witness before any kill, then be proven
	// dead specifically by SIGKILL, then be reaped, before a successor is allowed.
	for _, checkpoint := range []string{deathCaseHold} {
		t.Run("actual-death/"+checkpoint, func(t *testing.T) {
			producer := runDeathChild(t, exe, inv, checkpoint, true)
			if producer == "" {
				t.Fatal("armed child never reached the pre-kill witness (not a death case)")
			}
			if producer == producerSuccess {
				t.Fatal("a successor reused the baseline child's producer identity")
			}
		})
	}

	// Identity isolation across two real deaths: neither child reuses the other's
	// or the baseline's producer identity.
	first := runDeathChild(t, exe, inv, deathCaseHold, true)
	second := runDeathChild(t, exe, inv, deathCaseHold, true)
	if first == "" || second == "" {
		t.Fatal("identity-isolation children never reached the pre-kill witness")
	}
	if first == second || first == producerSuccess || second == producerSuccess {
		t.Fatalf("producer identity survived process death: baseline=%q first=%q second=%q", producerSuccess, first, second)
	}
	if strings.TrimSpace(inv) == "" || producerSuccess == "" {
		t.Fatal("parent lost its own liveness-scoped state")
	}
}

// runDeathChild execs this same binary as an independent child bound by an
// inherited control pipe, returns its announced producer identity, and proves the
// death outcome. When expectKill is set it must die specifically by SIGKILL and be
// reaped before returning; otherwise it must exit successfully and un-signaled.
func runDeathChild(t *testing.T, exe, invocation, checkpoint string, expectKill bool) string {
	t.Helper()
	parentReader, childWriter, err := os.Pipe()
	if err != nil {
		t.Fatalf("creating the parent<->child control pipe: %v", err)
	}
	defer parentReader.Close()

	cmd := exec.Command(exe, "-test.run", deathChildRun, "-test.timeout", "60s")
	// fd 3 is the first inherited ExtraFile; the child is told which descriptor.
	cmd.ExtraFiles = []*os.File{childWriter}
	cmd.Env = append(os.Environ(),
		deathControlFDEnv+"=3",
		deathCheckpointEnv+"="+checkpoint,
		deathInvocationEnv+"="+invocation)
	stdout, stderr := &boundedWriter{}, &boundedWriter{}
	cmd.Stdout, cmd.Stderr = stdout, stderr

	if err := cmd.Start(); err != nil {
		childWriter.Close()
		t.Fatalf("starting the child process: %v", err)
	}
	// The parent never writes the control pipe; close its copy so the child sees
	// EOF the instant it dies, and so cleanup cannot keep the pipe alive.
	childWriter.Close()

	reader := bufio.NewReader(parentReader)
	hs, err := readDeathHandshake(reader, 30*time.Second)
	if err != nil {
		_ = cmd.Process.Kill()
		cmd.Wait()
		t.Fatalf("armed child never reached the pre-kill witness: %v\nstdout=%q stderr=%q", err, stdout.String(), truncate(stderr.String()))
	}
	if hs.Checkpoint != checkpoint || hs.Invocation != invocation || hs.ProducerID == "" {
		_ = cmd.Process.Kill()
		cmd.Wait()
		t.Fatalf("child handshake drifted: %+v stdout=%q", hs, truncate(stdout.String()))
	}

	if !expectKill {
		waitErr := cmd.Wait()
		if waitErr != nil {
			t.Fatalf("baseline child did not exit successfully: %v\nstdout=%q stderr=%q", waitErr, truncate(stdout.String()), truncate(stderr.String()))
		}
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			t.Fatalf("baseline child exited by signal %v, not success", ws.Signal())
		}
		if stdout.overflowed() || stderr.overflowed() {
			t.Fatal("child stream overflowed the bounded parent reader")
		}
		return hs.ProducerID
	}

	if cmd.Process.Pid <= 0 {
		cmd.Wait()
		t.Fatal("armed child had no process identity to kill")
	}
	if err := cmd.Process.Kill(); err != nil {
		cmd.Wait()
		t.Fatalf("killing the armed child: %v", err)
	}
	waitErr := cmd.Wait()
	if waitErr == nil {
		t.Fatal("a SIGKILLed child reported a clean exit")
	}
	ps := cmd.ProcessState
	ws, ok := waitStatus(ps)
	if !ok || !ws.Signaled() || ws.Signal() != syscall.SIGKILL {
		sig := -1
		if ok && ws.Signaled() {
			sig = int(ws.Signal())
		}
		t.Fatalf("child death was not specifically SIGKILL; signaled=%v signal=%d exit=%q stdout=%q stderr=%q", ok && ws.Signaled(), sig, ps.String(), truncate(stdout.String()), truncate(stderr.String()))
	}
	// Wait returning proves the process is reaped before any successor is started.
	return hs.ProducerID
}

func truncate(s string) string {
	if len(s) > 512 {
		return s[:512] + "...(truncated)"
	}
	return s
}
