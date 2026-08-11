// Path-based build planning for publish-images.yml (agent-lcars#441).
//
// The workflow publishes six independently routed image groups from this repo:
//   - the runner-autoscaler control-plane image
//   - the JIT worker runner image (bakes in the telemetry-watcher bundle)
//   - the standalone telemetry-watcher daemon image (the same bundle)
//   - the standalone GitHub Actions metrics exporter image
//   - the pinned Playwright E2E sandbox image (agent-lcars#908)
//   - the lcars-e2e pool's JIT runner image: the sandbox above plus the
//     runner agent (agent-lcars#920)
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
// The exporter's Dockerfile copies only these files. README, tests, and Nx
// integration still run in CI but cannot change the published image, so do
// not spend the serialized builder lane on them.
const EXPORTER_IMAGE_FILES = new Set([
  'apps/github-actions-exporter/Dockerfile',
  'apps/github-actions-exporter/exporter.py',
  'apps/github-actions-exporter/requirements.lock',
]);

// tools/e2e-docker.sh and publish-images.yml both derive the image tag from
// this ONE file's content hash (agent-lcars#908) -- it has no COPY
// instructions, so it is the image's entire input; ci.env/screenshot.css/etc
// under tools/e2e/ are bind-mounted at run time, not baked in, and do not
// belong here.
const E2E_IMAGE_FILES = new Set(['tools/e2e/Dockerfile']);

// The lcars-e2e runner image's own build context (agent-lcars#920):
// tools/e2e-runner/Dockerfile plus anything else under that directory.
// Distinct from E2E_IMAGE_FILES above even though this image FROMs the
// sandbox that file builds -- see the shared-input invariant below for how
// the two stay linked.
const E2E_RUNNER_IMAGE_PREFIX = 'tools/e2e-runner/';

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
  return EXPORTER_IMAGE_FILES.has(file);
}

function isE2eImage(file) {
  return E2E_IMAGE_FILES.has(file);
}

function isE2eRunnerImage(file) {
  return file.startsWith(E2E_RUNNER_IMAGE_PREFIX);
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
      e2e: true,
      e2eRunner: true,
    };
  }
  const workflow = changedFiles.some(isWorkflowInfra);
  const bundleInput = changedFiles.some(isBundleInput);
  const e2eImage = changedFiles.some(isE2eImage);
  return {
    controlPlane: workflow || changedFiles.some(isControlPlane),
    jitRunner: workflow || bundleInput || changedFiles.some(isRunnerImage),
    watcher: workflow || bundleInput,
    exporter: workflow || changedFiles.some(isExporter),
    e2e: workflow || e2eImage,
    // The lcars-e2e runner image FROMs the sandbox image, so a sandbox
    // change must always reschedule this one too (agent-lcars#920) -- the
    // same "shared input" shape as the telemetry bundle invariant above,
    // just a build-time FROM instead of a baked-in bundle. Left to drift,
    // the pool would keep booting an environment whose fonts/browser build
    // no longer match what tools/e2e-docker.sh pulls locally.
    e2eRunner: workflow || e2eImage || changedFiles.some(isE2eRunnerImage),
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
  isE2eImage,
  isE2eRunnerImage,
  isExporter,
  isRunnerImage,
  isWorkflowInfra,
  parseChangedFiles,
  planImageBuilds,
};
