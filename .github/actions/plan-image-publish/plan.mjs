// Path-based build planning for publish-images.yml (agent-lcars#441).
//
// The workflow publishes four independently routed image groups from this repo:
//   - the runner-autoscaler control-plane image
//   - the JIT worker runner image (bakes in the telemetry-watcher bundle)
//   - the standalone telemetry-watcher daemon image (the same bundle)
//   - the standalone GitHub Actions metrics exporter image
//
// Building every group serially on every push -- including ones that only
// touch one of them, or touch none of them -- is what made a
// deployment-config-only telemetry-watcher change spend ~20 minutes of
// builder capacity for zero image builds (see the publish-images.yml
// header comment and agent-lcars#441 for the concrete evidence). This
// module decides which images actually need building from the set
// of changed file paths, so the workflow can skip the rest.
//
// The invariant this module exists to protect (agent-lcars#441's "Required
// invariant"): a change to the telemetry-watcher BUNDLE's inputs -- its own
// source, or anything it inlines -- must schedule BOTH the JIT runner and
// watcher builds, every time, with no way for the two to drift. Both
// images run the exact same `nx bundle @agent-lcars/telemetry-watcher`
// target (the JIT runner image's own Dockerfile clones this repo and runs
// it fresh, rather than reusing a local build -- see that Dockerfile's own
// comments), so isBundleInput() below covers the app's own source as well
// as its shared library dependencies. There is deliberately one list, not
// a separate "runner telemetry inputs" vs "watcher telemetry inputs" pair
// that could diverge.

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

// Everything the telemetry-watcher bundle target (`nx bundle
// @agent-lcars/telemetry-watcher`) inlines via esbuild, PLUS the app's own
// source -- baked into BOTH the JIT runner image and the standalone
// watcher image, since both run that exact bundle target (see this
// module's header comment). `apps/telemetry-watcher/deploy/**` and its
// top-level README are excluded below (WATCHER_EXEMPT_*): neither reaches
// the bundle, and agent-lcars#440 is the concrete regression where a
// deploy-config-only change still triggered a full, wasted publish.
const BUNDLE_INPUT_PREFIXES = [
  'apps/telemetry-watcher/',
  'libs/telemetry/',
  'libs/logging/',
  'libs/env-vars/',
  'libs/util/',
  'libs/util-server/',
  'patches/',
];
const BUNDLE_INPUT_FILES = new Set(['package.json', 'pnpm-lock.yaml']);
const WATCHER_EXEMPT_FILES = new Set(['apps/telemetry-watcher/README.md']);
const WATCHER_EXEMPT_PREFIXES = ['apps/telemetry-watcher/deploy/'];

// The JIT runner image's own Dockerfile and helper scripts (context:
// apps/runner-autoscaler/runner-image). Distinct from the control-plane
// inputs below even though both live under apps/runner-autoscaler --
// the control-plane image's build context never reads this subdirectory
// (its Dockerfile only COPYs go.mod/go.sum/*.go from the parent context).
// Unrelated to the bundle itself, so this schedules the JIT runner alone.
const RUNNER_IMAGE_PREFIX = 'apps/runner-autoscaler/runner-image/';

// The control-plane image's own inputs: everything else under
// apps/runner-autoscaler. Kept broad (matching the prior behavior for this
// image) since agent-lcars#441's evidence and acceptance criteria are
// about the watcher/JIT-runner side, not about narrowing this one further.
const CONTROL_PLANE_PREFIX = 'apps/runner-autoscaler/';
const EXPORTER_PREFIX = 'apps/github-actions-exporter/';

function startsWithAny(file, prefixes) {
  return prefixes.some((prefix) => file.startsWith(prefix));
}

function isWorkflowInfra(file) {
  return (
    WORKFLOW_INFRA_FILES.has(file) ||
    startsWithAny(file, WORKFLOW_INFRA_PREFIXES)
  );
}

function isWatcherExempt(file) {
  return (
    WATCHER_EXEMPT_FILES.has(file) ||
    startsWithAny(file, WATCHER_EXEMPT_PREFIXES)
  );
}

function isBundleInput(file) {
  if (isWatcherExempt(file)) return false;
  return (
    BUNDLE_INPUT_FILES.has(file) || startsWithAny(file, BUNDLE_INPUT_PREFIXES)
  );
}

function isRunnerImage(file) {
  return file.startsWith(RUNNER_IMAGE_PREFIX);
}

function isControlPlane(file) {
  return file.startsWith(CONTROL_PLANE_PREFIX) && !isRunnerImage(file);
}

function isExporter(file) {
  return file.startsWith(EXPORTER_PREFIX);
}

// `changedFiles === null` is the explicit "no well-defined diff" sentinel
// (a manual workflow_dispatch republish, or a push whose `before` SHA is
// unreachable -- see main.mjs) and always plans every image, the same safe
// default the rest of this workflow already applies to ambiguous input.
function planImageBuilds(changedFiles) {
  if (changedFiles === null) {
    return {
      controlPlane: true,
      jitRunner: true,
      watcher: true,
      exporter: true,
    };
  }
  const workflow = changedFiles.some(isWorkflowInfra);
  const bundleInput = changedFiles.some(isBundleInput);
  return {
    controlPlane: workflow || changedFiles.some(isControlPlane),
    jitRunner: workflow || bundleInput || changedFiles.some(isRunnerImage),
    watcher: workflow || bundleInput,
    exporter: workflow || changedFiles.some(isExporter),
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
  isBundleInput,
  isControlPlane,
  isExporter,
  isRunnerImage,
  isWorkflowInfra,
  parseChangedFiles,
  planImageBuilds,
};
