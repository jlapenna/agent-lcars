# Inbox phone interaction budget

FE-NF-7 targets p95 below 2,000 ms, separately for browser-cold and browser-warm
cases. A controlled lab result is not production qualification.

## User-ready milestone

Measure a direct `/inbox?item=…` decision navigation from its browser navigation
start until the loaded decision's actual primary-action handler opens the
visible confirmation dialog. The lab cancels that confirmation: it never
approves, merges, dispatches, or writes a real Work item. Server-rendered enabled
markup alone is not readiness evidence.

The current probe waits for document load before clicking. It is therefore a
conservative journey-completion upper bound, not the earliest possible
hydration instant or the retired Lighthouse TTI metric. The same barrier must
be used in before/after comparisons. Do not remove it only from the faster run.

## Fixed lab workload and profile

Use the existing `seed-inbox` fixture: populated GitHub decision reasons,
running/finished Work and CLI-session projections, and two native parked
decisions. The selected decision is PR #9003 in the synthetic repository. This
is a representative mixed-state regression workload, not a production-size or
many-repository stress claim.

- Chromium, 390 × 844 CSS pixels, device scale 2, mobile/touch context.
- CDP CPU slowdown 4×, 150 ms requested network latency, 1.6 Mbps download,
  750 Kbps upload; software emulation, not a physical mid-range phone.
- Server process already warm, authoritative dummy data/auth still exercised.
- Cold: new context, browser HTTP cache cleared and disabled.
- Warm: new context, one untimed identical journey, then a timed identical
  navigation with HTTP cache enabled. No Next.js SPA-prefetch result is claimed.
- Interleave warm/cold cases, 30 measured navigations per case, one worker,
  no retries. Five samples are permitted only for harness smoke diagnostics.
- p95 is nearest rank: sorted values at `ceil(0.95 × n) - 1`; never pool cases.
  Thirty samples establish a lab baseline, not a tight population confidence
  interval. Record host contention and browser version when comparing runs.

## Bounded measurement

Run against an **already running, isolated hermetic production bundle** with
the checked-in `tools/e2e/ci.env` dummy environment and loopback Firebase
emulators. Build/boot through the existing E2E or isolated development setup;
do not use a dev-mode bundle, production credentials, or a live deployment.
Keep its ports distinct from other worktrees and the fixed-port E2E lane.

```sh
env -i PATH="$PATH" HOME="$HOME" \
  E2E_HERMETIC=1 PROJECT_ID=demo-no-project \
  FIRESTORE_EMULATOR_HOST=127.0.0.1:4362 \
  node tools/e2e/measure-inbox-phone.mjs \
  --origin http://localhost:4204 --samples 30 --out /tmp/inbox-phone-before.json
```

The command rejects non-loopback targets, non-demo environments, and sample
counts outside 5–60 before seeding. Each operation has a 30-second timeout and
the browser run has a 15-minute bound. It writes raw samples, resource sizes
and durations, browser/host/profile metadata, and separate summary quantiles.
A failure produces partial evidence with an error, not a passing percentile.
The output path must be new; do not overwrite a baseline. Exit 1 means an
operational/interaction failure; inspect each case's `targetMet` separately.

Record the server's exact source revision and production build command beside
the artifact. The tool's Git revision describes the invoking checkout; it does
not independently attest which revision an arbitrary running server serves.
Retain the same profile, milestone, fixture, build mode and browser version
for the after artifact. Keep build output stable during each measurement.

The maintainer owns this on-demand signal and acts on misses under #2201.
Required E2E remains the semantic interaction gate; machine-dependent lab
percentiles do not replace or weaken required merge checks.

### Hosts with unrelated network-interface turnover

Chromium can abort a loopback request with `ERR_NETWORK_CHANGED` when another
workload changes a host interface (#2843). The probe preserves these errors and
partial samples; a retry or successful incomplete cohort is not qualification.
For an isolated series on a prepared Linux systemd host, put the **entire**
normal helper, including Firebase, the Console and Chromium, in one
`PrivateNetwork=yes` unit. Isolating only the browser separates it from the
server's loopback interface and cannot work.

Opt in with `E2E_NETWORK_MODE=loopback`. The normal helper checks the current
namespace before taking its host lock, allocating its temporary HOME, building,
or touching ports. It refuses unless `/proc/self/net/dev` contains only `lo`
(including unconfigured interfaces) and that interface has a loopback address.
The direct measurement probe also checks the boundary and records its namespace
identity. The external supervisor creates the namespace; this option never
changes networking, invokes sudo, or silently falls back to the host. Default
host/CI execution is unchanged.

Prepare the checkout normally with `./tools/setup-worktree.sh` on the ordinary
network and use a host with the matching Playwright browser and its system
libraries already installed through the owning prerequisite path in
[`e2e-reliability.md`](e2e-reliability.md). The helper's browser preflight never
downloads or repairs a missing browser. Run
`E2E_GREP='@smoke' ./tools/e2e-local.sh` on the ordinary network to qualify that
setup and populate durable emulator/tool caches; keep its result separate from
the measured cohort. Each invocation uses a fresh temporary Nx L1 cache, so
that run does **not** retain a reusable production-build L1 for the isolated
run. Budget the normal production build again on a cache miss. The private
namespace cannot download missing tools or reach the remote Nx cache;
missing prerequisites and build failures still fail normally. Do not disable
plugins, hooks, browser checks or cache guards to make an offline run succeed.

After qualifying CPU, memory, storage and overlap for the complete phase on one
supported host, launch from its dedicated worktree. This example uses a 2 CPU,
4 GiB, no-swap, 30-minute envelope; qualify it against that host's current
capacity and required reserves before use. Use a unique unit name for each
attempt and retain the unit's actual exit and accounting with the full artifact:
`--wait` prints them on exit, and `--collect` then unloads the unit so a failed
attempt does not linger in `systemctl --failed`.

```sh
node_bin="$(dirname "$(readlink -f "$(command -v node)")")"
sudo systemd-run --unit=lcars-inbox-phone-UNIQUE --collect \
  --property="User=$(id -un)" --property=PrivateNetwork=yes \
  --property=CPUQuota=200% --property=MemoryMax=4G \
  --property=MemorySwapMax=0 --property=RuntimeMaxSec=1800 \
  --property=TimeoutStopSec=15 --property=KillMode=control-group \
  --working-directory="$PWD" \
  --setenv="PATH=$node_bin:$PATH" \
  --setenv=E2E_NETWORK_MODE=loopback \
  --setenv='E2E_GREP=records cold and warm decision readiness' \
  --wait --pipe "$PWD/tools/e2e-local.sh"
```

All 30 cold and 30 warm samples, real browser-error rejection and fixture/server
cleanup still apply. Record the unit's `PrivateNetwork` setting and compare the
artifact's `environment.network.namespace` with a process in that unit. A
passing isolated cohort qualifies this execution boundary; it does not identify
which historical interface or request triggered the original host failure.

## Production instrumentation handoff

Qualification requires opt-in/privacy-reviewed production measurements of the
same loaded-decision/hydrated-action milestone. Separate cold/warm navigation,
route, device/network class and deployed revision; report sample count, window
and percentile definition. Exclude issue bodies, question text, transcripts,
credentials, full URLs and identifiers. Do not assume console-admin auth grants
telemetry permission. Physical-device/real-network evidence and server-cold
behavior remain separate from this software-throttled, warm-server lab.

No RUM collector, new infrastructure, external notification or production
mutation is activated by this measurement tool. Keep FE-NF-7 unqualified until
the actual target and production acceptance have evidence; preserve dated
baseline/after observations in the issue and PR rather than treating them as
live policy.

## Cold-path diagnosis

Schema 2 retains the same journey and adds navigation-relative resource start,
response-start and response-end timestamps, DOM/load events, document-load
observation, click request, captured primary click and confirmation observation
(`readyMs`). Compare the document response, the last required script transfer,
load event, click dispatch and visible confirmation before selecting an owner.
Observation checkpoints include Playwright scheduling and are upper bounds.
The click event proves dispatch; it does not identify the exact hydration instant.

Long-task entries cover tasks of at least 50 ms from navigation to confirmation,
with a 200-entry cap. CDP task/script/compile/layout/style/DevTools collection starts after the untimed
warmup. Schema 3 reports the timed renderer's current counters in milliseconds,
including **Cancel cleanup** through the final metrics read. A renderer-agent
restoration can reset counters during navigation; they are not cross-renderer
totals, and subtracting an older document's warmup counters produces invalid
negative durations. Preserve this scope when comparing artifacts. They use the
explicit CDP `timeTicks` wall-time domain, not CPU
utilization or a hydration profile. Script/layout/style durations are subsets
of task duration. Tasks can overlap resource transfers: do not add them to a
waterfall or subtract their sum from total readiness to invent a causal split.
A gap between click request and dispatch can include hydration, Playwright
visibility/stability checks and scheduling; inspect a browser trace when further
attribution is needed. Start/end system load averages and free-memory observations accompany CPU model
and browser version. They are contention diagnostics, not host-capacity proof
or a guarantee of an uncontended run. The instrumentation itself adds observation overhead;
compare before/after with the same probe revision.

The selected console E2E suite also executes `inbox-phone-lab.spec.ts` with 30
interleaved samples per case and no retries, retaining `inbox-phone-lab.json`
in its normal diagnostics artifact (14-day CI retention). This gives the
maintainer an owned controlled-CI timing signal and exercises the probe against
an actual hermetic production bundle. E2E fails on a broken probe or journey;
it does not fail solely because `targetMet` is false. Runner/browser changes and
contention mean CI artifacts are a separate lab series from earlier host runs.
Compare exact revisions on the same runner/profile before claiming improvement.
Download and preserve the raw artifact before retention expires when using it
as acceptance evidence. The test has a 16-minute bound around the probe's
15-minute deadline; the existing serial CI job retains its 30-minute bound.

## Server-known decision context

Inbox and Bridge decision bodies are parsed by the canonical `ConsoleMarkdown`
renderer on the server, then passed as rendered context into the interactive
card. This preserves escaped HTML, safe Markdown links, GFM, and the existing
disclosures without shipping their parser in the initial Inbox client graph.
The loaded item and primary action still come from the same fresh server read;
confirmation and cancellation stay in the existing client handler. Compare
the navigation document (HTML plus streamed RSC) and resource transferred bytes,
server response timing, and the unchanged milestone, not parser source size
alone, before attributing a timing improvement.

## Opt-in loopback TLS transport diagnostic

`Inbox phone TLS transport diagnostic` is a **manual-only** workflow, dispatched
from protected `main` after source review and protected merge. It uses the
existing `agent-lcars-e2e` sandbox, the normal hermetic production build and
emulators, and the ordinary browser prerequisite check. Missing prerequisites
fail; the native source-author Job is not a browser sandbox. No production
endpoint, auth change, trust installation, runner change or required CI job is
part of this experiment. Ordinary CI skips the new spec by default.

The hermetic entrypoint admits only `E2E_INBOX_TLS_DIAGNOSTIC=1` (unset is the
default; other values fail), together with its existing `E2E_GREP` selection.
The opted-in spec downloads the standard Linux amd64 Caddy **v2.11.7** archive
into its private task temporary directory, checking exactly 18,113,754 bytes
and SHA256 `727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b`.
It neither installs nor builds Caddy. A task-local public self-signed certificate
and private key terminate TLS on `127.0.0.1` only. Caddy has admin, automatic
HTTPS and config persistence off; it adds no encoding, recompression or cache.
Its HTTP/1.1 upstream has automatic compression disabled so the client's gzip
negotiation reaches the unchanged Next server. Only the frontend server
protocol list changes between `h1` and `h1 h2`; HTTP/3 is excluded.
See [Caddy protocols](https://caddyserver.com/docs/caddyfile/options#protocols).

The probe remains HTTP-loopback-only by default. HTTPS additionally requires
both `--tls-diagnostic` and `--tls-certificate <temporary-public-cert.pem>`.
Incomplete pairs, remote or credential-bearing origins, paths/queries/fragments,
non-demo/emulator environments and invalid certificates fail before browser or
seed. The measurement process reads only the public certificate. Its Node
seed request uses builtin HTTPS with that explicit CA and normal hostname
verification. Its separate Chromium process receives only the derived SHA256
SPKI allowlist, following Chromium's
[certificate verifier contract](https://chromium.googlesource.com/chromium/src/+/main/services/network/ignore_errors_cert_verifier.h).
There is no global TLS disable, general certificate-error bypass or host trust
change. Node and Chromium positive/negative controls must accept the selected
certificate and refuse an unrelated certificate before samples begin.

Four blocks run **H1, H2, H2, H1**, each with 15 cold and 15 warm samples. The
120 raw rows yield separate nearest-rank n=30 cold/warm summaries for each arm.
No arm or cache pooling is permitted. All blocks share the same backend,
production bundle, proxy, origin, certificate, browser version, seeded #9003
fixture, phone profile, load barrier and real primary-action confirmation plus
Cancel. Each helper retains its 5–60 sample bounds, 30-second operation and
15-minute invocation bounds; the entire diagnostic has a 24-minute deadline
inside the unchanged 30-minute job, with bounded cleanup of owned processes.
A failed journey or harness fails; missing the 2,000 ms budget alone does not.

Cold navigation and static-JS resource protocols must match the selected arm;
selected response metadata must show gzip. Only bounded safe response fields
(content-encoding, vary, content-length, cache-control, etag and age), timings,
byte counts, decoded public-JS SHA256 hashes, build hashes, certificate hashes
and raw measurement rows are retained. Browser JS must equal the local built
static corpus; the sorted decoded corpus and encoded resource byte counts must
match across all cold samples and arms. Mixed protocols, bytes or builds make
the diagnostic confounded/incomplete, never a passing comparison. No request
headers, cookies, auth data, dynamic response bodies, public-JS source text or
private keys are captured by the transport diagnostic. Keys and proxy files
stay outside the uploaded test-output directory. Partial failures and all
completed blocks remain in the normal diagnostics artifact for 14 days.

This is a **new TLS lab series**. The accepted `9fa20de` HTTP cold p95 4,808 ms /
warm 1,887.3 ms series remains separate. The observed HTTP/1.1 request-start
gaps justify testing transport; they do not establish a six-connection cause,
a production bottleneck or a causal improvement. Smoke controls and older
baselines are not an after result. #2201 stays open for its original cold
budget and production instrumentation gates. Source delivery does not mean the
manual transport experiment has run or qualified an improvement.
