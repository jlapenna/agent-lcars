// Path-based build planning for publish-images.yml (agent-lcars#441).
//
// The workflow publishes three DIFFERENT artifacts from this one repo:
//   - the runner-autoscaler control-plane image
//   - the JIT worker runner image (bakes in the telemetry-watcher bundle)
//   - the standalone telemetry-watcher daemon image (the same bundle)
//
// Building all three serially on every push -- including ones that only
// touch one of them, or touch none of them -- is what made a
// deployment-config-only telemetry-watcher change spend ~20 minutes of
// builder capacity for zero image builds (see the publish-images.yml
// header comment and agent-lcars#441 for the concrete evidence). This
// module decides which of the three actually need building from the set
// of changed file paths, so the workflow can skip the rest.
//
// The invariant this module exists to protect (agent-lcars#441's "Required
// invariant"): a change to shared telemetry source or its dependencies must
// schedule BOTH the JIT runner and watcher builds, every time, with no way
// for the two to drift. SHARED_TELEMETRY_PREFIXES/FILES below is the single
// list both routes read from -- there is deliberately no separate "runner
// telemetry inputs" vs "watcher telemetry inputs" list to keep in sync.

// Anything under these prefixes changes what publish-images.yml itself does
// -- how an image is built, scanned, or routed -- which is as much a reason
// to rebuild everything as a source change (see that workflow's own
// existing comment about .github/actions/scan-image for the same
// reasoning, agent-lcars#224). Kept as full rebuild-everything triggers
// rather than trying to reason about which job each line affects.
const WORKFLOW_INFRA_FILES = new Set(['.github/workflows/publish-images.yml']);
const WORKFLOW_INFRA_PREFIXES = [
  '.github/actions/scan-image/',
  '.github/actions/plan-image-publish/',
];

// Every third-party dependency and internal lib the telemetry-watcher
// bundle target (`nx bundle @agent-lcars/telemetry-watcher`) inlines via
// esbuild -- baked into BOTH the JIT runner image and the standalone
// watcher image. Mirrors the prior paths-filter list this module replaces;
// see publish-images.yml's header comment for why each entry is here.
const SHARED_TELEMETRY_PREFIXES = [
  'libs/telemetry/',
  'libs/logging/',
  'libs/env-vars/',
  'libs/util/',
  'libs/util-server/',
  'patches/',
];
const SHARED_TELEMETRY_FILES = new Set(['package.json', 'pnpm-lock.yaml']);

// The JIT runner image's own Dockerfile and helper scripts (context:
// apps/runner-autoscaler/runner-image). Distinct from the control-plane
// inputs below even though both live under apps/runner-autoscaler --
// the control-plane image's build context never reads this subdirectory
// (its Dockerfile only COPYs go.mod/go.sum/*.go from the parent context).
const RUNNER_IMAGE_PREFIX = 'apps/runner-autoscaler/runner-image/';

// The control-plane image's own inputs: everything else under
// apps/runner-autoscaler. Kept broad (matching the prior behavior for this
// image) since agent-lcars#441's evidence and acceptance criteria are
// about the watcher/JIT-runner side, not about narrowing this one further.
const CONTROL_PLANE_PREFIX = 'apps/runner-autoscaler/';

// Watcher paths that do NOT affect the published image: the standalone
// per-host deployment config (docker-compose.yml, .env.example, deploy.sh,
// its own README) and the app's top-level README. Concrete evidence this
// matters: agent-lcars#440 changed exactly deploy/docker-compose.yml and
// deploy/README.md and triggered a full, wasted publish run (agent-lcars#441
// issue comment). Deliberately narrow -- everything else under the app
// (src/**, project.json, tsconfig*, vitest config, eslint config) can
// plausibly change what `nx bundle` produces or how it's verified, so it
// stays a trigger rather than risk silently shipping stale code (the same
// "loud beats silent" default publish-images.yml already applies elsewhere).
const WATCHER_EXEMPT_FILES = new Set(['apps/telemetry-watcher/README.md']);
const WATCHER_EXEMPT_PREFIXES = ['apps/telemetry-watcher/deploy/'];
const WATCHER_PREFIX = 'apps/telemetry-watcher/';

function startsWithAny(file, prefixes) {
  return prefixes.some((prefix) => file.startsWith(prefix));
}

function isWorkflowInfra(file) {
  return (
    WORKFLOW_INFRA_FILES.has(file) ||
    startsWithAny(file, WORKFLOW_INFRA_PREFIXES)
  );
}

function isSharedTelemetry(file) {
  return (
    SHARED_TELEMETRY_FILES.has(file) ||
    startsWithAny(file, SHARED_TELEMETRY_PREFIXES)
  );
}

function isRunnerImage(file) {
  return file.startsWith(RUNNER_IMAGE_PREFIX);
}

function isControlPlane(file) {
  return file.startsWith(CONTROL_PLANE_PREFIX) && !isRunnerImage(file);
}

function isWatcherExempt(file) {
  return (
    WATCHER_EXEMPT_FILES.has(file) ||
    startsWithAny(file, WATCHER_EXEMPT_PREFIXES)
  );
}

function isWatcher(file) {
  return file.startsWith(WATCHER_PREFIX) && !isWatcherExempt(file);
}

// `changedFiles === null` is the explicit "no well-defined diff" sentinel
// (a manual workflow_dispatch republish, or a push whose `before` SHA is
// unreachable -- see main.mjs) and always plans every image, the same safe
// default the rest of this workflow already applies to ambiguous input.
function planImageBuilds(changedFiles) {
  if (changedFiles === null) {
    return { controlPlane: true, jitRunner: true, watcher: true };
  }
  const workflow = changedFiles.some(isWorkflowInfra);
  const sharedTelemetry = changedFiles.some(isSharedTelemetry);
  return {
    controlPlane: workflow || changedFiles.some(isControlPlane),
    jitRunner: workflow || sharedTelemetry || changedFiles.some(isRunnerImage),
    watcher: workflow || sharedTelemetry || changedFiles.some(isWatcher),
  };
}

// Parses `git diff --name-only`'s output (one repo-relative path per line).
function parseChangedFiles(diffOutput) {
  return diffOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export {
  isControlPlane,
  isRunnerImage,
  isSharedTelemetry,
  isWatcher,
  isWorkflowInfra,
  parseChangedFiles,
  planImageBuilds,
};
