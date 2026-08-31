---
name: debug-agent-run
description: Diagnose a dispatched QueueExecutor/direct-runner agent run using the fleet's own observability instead of waiting on GitHub - the live runner container on laforge/janeway/spark, Loki, Prometheus, and the LiteLLM logs. Use when an agent run is slow, silent, stuck, or finished badly; when you want to know whether it has actually committed anything yet; when asking "is it working or hung"; or before concluding a run failed for a reason you have not measured.
---

# Debugging a dispatched agent run

**You do not have to wait for GitHub.** This is the single most common mistake
when triaging a run, and it costs an hour every time. `gh run view --log`
returns `BlobNotFound` for a job that is still running — GitHub does not
publish the log blob until the job ends. That is a fact about GitHub, not a
fact about what you can observe.

The runner is a **live container on a host you have SSH to**. Its workspace,
its git state, and the model traffic it is generating are all readable _right
now_. Reach for those first and reserve `gh run view --log` for the
post-mortem measurements in §4.

## 0. The two questions worth answering first

Almost every triage reduces to one of these, and both are answerable in under
a minute without GitHub:

| Question                           | Where the answer is                  |
| ---------------------------------- | ------------------------------------ |
| Has it actually produced anything? | The runner's working tree — §2       |
| Is it working, throttled, or hung? | LiteLLM completion rate in Loki — §3 |

An agent can look identical from GitHub whether it is thinking hard, starved
by a competing run, or wedged. It does not look identical in these two places.

## 1. Find the live container

`scripts/run-evidence.sh` does all of this; run it before doing anything by
hand. What it does, so you can do it manually when it does not fit:

Hop to the `homelab` bastion first — it holds the automation key that reaches
the rest of the fleet (see the **oncall** skill's §0 for why, and for the
separate-users gotcha on `pike`). From there, scan the hosts:

```bash
ssh homelab@homelab.lan.jlapenna.net
for h in laforge janeway spark pike oldbook; do
  ssh -i ~/p/homelab/ansible/ssh_key/id_ed25519 homelab@$h.lan.jlapenna.net \
    'docker ps --filter name=runner- --format "{{.Names}}|{{.CreatedAt}}"'
done
```

**Match the container to your run by creation time**, not by name — the name's
suffix is random. A QueueExecutor container created within ~30s of your
dispatch is yours. `lcars-ci` and `control` are different work.

> **Nested-quoting trap.** `ssh → ssh → docker exec` mangles quotes three
> times over and you will lose several minutes to it. Base64 the inner script
> and decode it at the far end:
> `B64=$(printf '%s' "$SCRIPT" | base64 -w0)` … `bash -c "echo $B64 | base64 -d | bash"`.

## 2. Ground truth: has it committed anything?

This is the question the deliverable gate ultimately answers, and you can
answer it directly, mid-run, for free:

```bash
docker exec <container> bash -lc '
  cd /home/runner/_work/agent-lcars/agent-lcars
  git rev-list --count origin/main..HEAD    # commits made
  git status --porcelain | wc -l            # uncommitted edits
  git worktree list                         # agents here create one per issue
'
```

**Check every worktree, not just the main checkout.** This repo mandates
worktrees, so a compliant agent's work is in `agent-lcars-<issue>/` and the
main checkout looks pristine while real edits sit next door.

Reading these three numbers together tells you which failure you have, and
they are genuinely different problems:

| commits | dirty | What it means                                                       |
| ------: | ----: | ------------------------------------------------------------------- |
|       0 |     0 | Still in reconnaissance. Not a commit problem — it has not started. |
|       0 |    >0 | **Work exists and will be destroyed** when the runner is torn down. |
|      >0 |   any | It is checkpointing. Whatever else is wrong, the work will survive. |

## 3. Is it working, or starved?

LiteLLM's logs in Loki give the model-call rate, which is the agent's real
pulse:

```bash
curl -sG "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query=sum(count_over_time({container="litellm"} |= "chat/completions" [5m]))' \
  --data-urlencode "start=$(date -u -d '35 min ago' +%s)000000000" \
  --data-urlencode "end=$(date -u +%s)000000000" \
  --data-urlencode "step=300"
```

Rough calibration measured 2026-08-16, one OpenCode agent, thinking disabled:
**~1.5 completions/min**. A bucket near zero while the run is live means
throttling or a wedged engine, not thinking.

**Serialise agent dispatches.** Two concurrent OpenCode runs measured ~2.3
completions/min _combined_ — roughly half throughput each, with a five-minute
near-stall. Spark is one GPU with a two-session ceiling. Dispatching a second
agent to "get evidence faster" makes both runs slower and confounds whatever
you were measuring.

### Do not attribute background noise to your run

Check the rate over hours before blaming anything on the run in front of you.
LiteLLM has logged a steady **240 auth rejections per 30 minutes, all day**
(`401: LiteLLM Virtual Key expected ... expected to start with 'sk-'`), plus
recurring `CryptoError` on its `GENERIC_*` SSO keys. Both are unrelated to
agent dispatches. A flat rate across a window where runs both succeeded and
failed is the tell.

Useful error greps against `{container="litellm"}`: `capacity`, `503`,
`ServiceUnavailable`, `429`. Note `default-nothink` has **no fallback group**
(homelab#662), so a capacity rejection hard-fails the run.

## 4. What Loki does _not_ have

The runner containers' stdout in Loki is the **GitHub Actions runner agent's
own diagnostics** — `JobServerQueue`, `HostContext`, lease renewals — not the
agent step's output. The same is true of `/home/runner/_diag/Worker_*.log`
inside the container. The step's stdout is batched straight to GitHub.

So the model transcript really does need the finished run. Once it completes,
these are the measurements worth taking:

```bash
gh run view <run-id> --log | perl -pe 's/\e\[[0-9;]*m//g' > run.log
grep -c 'agent: "compaction"' run.log      # vs step count: see below
grep -c 'step: [0-9]'         run.log
grep -c '"command":"[^"]*git commit' run.log
```

**Compactions per step is the diagnostic that matters.** Compaction evicts the
file contents the agent has read, so a high rate means an agent whose working
memory is being wiped and who re-reads the same documents forever. Better than
one per ~15 steps is healthy; one per ~5 means the declared context limit is
wrong — see [docs/opencode-context-limit.md](../../../docs/opencode-context-limit.md),
which has the measured history and the bounds.

## 5. Order of operations

1. `scripts/run-evidence.sh` — container, git state, LLM rate, in one shot.
2. If `commits=0, dirty=0`: it has not started. Check the LLM rate before
   assuming it is stuck.
3. If `dirty>0`: work exists and is at risk. That is the urgent case.
4. If the rate is near zero: check for contention (another agent run) and for
   capacity errors, in that order.
5. Only after the run ends, pull the transcript for compaction/step counts.

## Related

- **oncall** (homelab) — bastion access, the fleet's alert pipeline, and Spark
  inference troubleshooting when the model server itself is the problem.
- **github-ci-monitor** — for _PRs_ awaiting checks, which is a different
  question from a _run_ behaving badly.
