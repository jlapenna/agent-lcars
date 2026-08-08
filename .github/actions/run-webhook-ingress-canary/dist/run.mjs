// apps/dispatch-broker/src/webhook-ingress-canary/run.ts
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// libs/dispatch-contracts/src/pipelines.ts
var PIPELINE_CONTRACTS = Object.freeze({
  claude: Object.freeze({
    pipeline: "claude",
    contract: "agent",
    workflowFile: "claude.yml",
    displayName: "Claude",
    runNameLabel: "Claude issue agent",
    label: "agent:claude",
    reviewLabel: "review:claude",
    replyTrigger: "@claude",
    replyTriggerAliases: Object.freeze([]),
    redispatchCommand: "@claude",
    botLogin: "claude[bot]"
  }),
  codex: Object.freeze({
    pipeline: "codex",
    contract: "agent",
    workflowFile: "codex.yml",
    displayName: "Codex",
    runNameLabel: "Codex issue agent",
    label: "agent:codex",
    reviewLabel: "review:codex",
    replyTrigger: "/codex",
    replyTriggerAliases: Object.freeze([]),
    redispatchCommand: "/codex",
    botLogin: "agent-lcars[bot]"
  }),
  opencode: Object.freeze({
    pipeline: "opencode",
    contract: "agent",
    workflowFile: "opencode.yml",
    displayName: "OpenCode",
    runNameLabel: "OpenCode issue agent",
    label: "agent:opencode",
    reviewLabel: "review:opencode",
    replyTrigger: "/oc",
    replyTriggerAliases: Object.freeze(["/opencode"]),
    redispatchCommand: "/opencode",
    botLogin: "agent-lcars[bot]"
  }),
  canary: Object.freeze({
    // #307's no-op production canary. It carries no label, no reply command,
    // and no bot login because nothing may ever select it from an issue: the
    // only way to produce a `canary` intent is normalize.mjs's dedicated
    // workflow_dispatch `kind: 'canary'` branch, fired exclusively by this
    // repo's own trusted dispatch-canary.yml/post-deploy-smoke.yml.
    pipeline: "canary",
    contract: "canary",
    workflowFile: "agent-dispatch-canary.yml",
    displayName: "Dispatch canary",
    runNameLabel: "Dispatch canary worker",
    replyTriggerAliases: Object.freeze([])
  })
});
var DISPATCH_PIPELINES = Object.freeze(
  Object.keys(PIPELINE_CONTRACTS)
);
var AGENT_PIPELINES = Object.freeze(
  DISPATCH_PIPELINES.filter(
    (pipeline) => PIPELINE_CONTRACTS[pipeline].contract === "agent"
  )
);
var WORKER_WORKFLOW_FILES = Object.freeze(
  new Set(
    DISPATCH_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].workflowFile
    )
  )
);
var AGENT_LABELS = new Map(
  AGENT_PIPELINES.map((pipeline) => [
    PIPELINE_CONTRACTS[pipeline].label,
    pipeline
  ])
);
var REVIEW_LABELS = new Map(
  AGENT_PIPELINES.map((pipeline) => [
    PIPELINE_CONTRACTS[pipeline].reviewLabel,
    pipeline
  ])
);
var DISPATCH_LABELS = Object.freeze([
  ...AGENT_LABELS.keys(),
  ...REVIEW_LABELS.keys()
]);
var REPLY_COMMANDS = new Map(
  AGENT_PIPELINES.flatMap((pipeline) => {
    const contract = PIPELINE_CONTRACTS[pipeline];
    return [
      contract.replyTrigger,
      ...contract.replyTriggerAliases
    ].map((command) => [command, pipeline]);
  })
);
var AGENT_BOT_LOGINS = Object.freeze([
  ...new Set(
    AGENT_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].botLogin
    )
  )
]);

// libs/dispatch-contracts/src/oidc.ts
var HOSTED_COMPLETION_PATH = "/api/control-plane/completion";
var HOSTED_COMPLETION_URL = `https://agent-console.supersprinkles.racing${HOSTED_COMPLETION_PATH}`;
var WEBHOOK_INGRESS_CANARY_OIDC_AUDIENCE = "agent-lcars-webhook-ingress-canary";
var WEBHOOK_INGRESS_PROBE_PATH = "/api/control-plane/webhook/probe";
var WEBHOOK_INGRESS_PROBE_URL = `https://agent-console.supersprinkles.racing${WEBHOOK_INGRESS_PROBE_PATH}`;

// libs/dispatch-contracts/src/webhook-ingress.ts
var WEBHOOK_INGRESS_CANARY_MARKER = "<!-- agent-lcars:webhook-ingress-canary:v1 -->";
var WEBHOOK_INGRESS_CANARY_TITLE = "GitHub App webhook ingress canary sentinel";

// apps/dispatch-broker/src/webhook-ingress-canary/run.ts
var API_VERSION = "2022-11-28";
var POLL_INTERVAL_MS = 2e3;
var TIMELINE_TIMEOUT_MS = 6e4;
var DELIVERY_TIMEOUT_MS = 9e4;
var AUTHORITY_TIMEOUT_MS = 18e4;
var WebhookIngressCanaryError = class extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
    this.name = "WebhookIngressCanaryError";
  }
  category;
};
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function output(name, value) {
  const outputFile = required("GITHUB_OUTPUT");
  const safe = String(value).replace(/[\r\n]+/gu, " ").slice(0, 1e3);
  fs.appendFileSync(outputFile, `${name}=${safe}
`, { encoding: "utf8" });
}
function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
function createAppJwt(clientId, privateKey, now = Date.now()) {
  const issuedAt = Math.floor(now / 1e3) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: clientId, iat: issuedAt, exp: issuedAt + 600 })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}
async function requestJson(url, token, options = {}, parse = (body) => JSON.parse(body)) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", API_VERSION);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${options.method ?? "GET"} ${new URL(url).pathname}: ${body}`
    );
  }
  return parse(body);
}
function parseAppDeliverySummaries(body) {
  const lossless = body.replace(/("id"\s*:\s*)([1-9]\d*)/gu, '$1"$2"');
  const parsed = JSON.parse(lossless);
  if (!Array.isArray(parsed) || parsed.some(
    (delivery) => !delivery || typeof delivery !== "object" || typeof delivery.id !== "string" || !/^[1-9]\d*$/u.test(delivery.id)
  )) {
    throw new Error("GitHub App delivery list contains an invalid int64 ID");
  }
  return parsed;
}
function api(path) {
  return `https://api.github.com${path}`;
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
function assertSentinelSafe(issue) {
  if (issue.title !== WEBHOOK_INGRESS_CANARY_TITLE || !issue.body?.includes(WEBHOOK_INGRESS_CANARY_MARKER)) {
    throw new WebhookIngressCanaryError(
      "sentinel_identity_mismatch",
      `Issue #${issue.number} does not match the canonical sentinel identity`
    );
  }
  const labels = (issue.labels ?? []).map(
    (label) => typeof label === "string" ? label : label.name
  );
  const dispatchLabels = new Set(DISPATCH_LABELS);
  const dispatchLabel = labels.find(
    (label) => Boolean(label && dispatchLabels.has(label))
  );
  if (dispatchLabel) {
    throw new WebhookIngressCanaryError(
      "sentinel_dispatch_label",
      `Sentinel #${issue.number} carries forbidden dispatch label ${dispatchLabel}`
    );
  }
}
async function findOrCreateSentinel(repository, githubToken) {
  const matches = [];
  for (let page = 1; ; page += 1) {
    const issues = await requestJson(
      api(`/repos/${repository}/issues?state=all&per_page=100&page=${page}`),
      githubToken
    );
    matches.push(
      ...issues.filter(
        (issue2) => !issue2.pull_request && issue2.title === WEBHOOK_INGRESS_CANARY_TITLE && issue2.body?.includes(WEBHOOK_INGRESS_CANARY_MARKER)
      )
    );
    if (issues.length < 100) break;
  }
  if (matches.length > 1) {
    throw new WebhookIngressCanaryError(
      "duplicate_sentinel",
      `Found ${matches.length} webhook ingress sentinel issues`
    );
  }
  const issue = matches[0] ?? await requestJson(
    api(`/repos/${repository}/issues`),
    githubToken,
    {
      method: "POST",
      body: JSON.stringify({
        title: WEBHOOK_INGRESS_CANARY_TITLE,
        body: `${WEBHOOK_INGRESS_CANARY_MARKER}

Dedicated model-free sentinel for the real GitHub App webhook ingress path. This issue must never carry an agent:* or review:* label. Scheduled probes alternate close/reopen and require the exact timeline event, App delivery, Cloud Tasks receipt, and authoritative controller observation.`
      })
    }
  );
  assertSentinelSafe(issue);
  return issue;
}
async function listTimeline(repository, issue, githubToken) {
  return requestJson(
    api(`/repos/${repository}/issues/${issue}/timeline?per_page=100`),
    githubToken
  );
}
async function pollTimelineEvent(repository, issue, action, baseline, startedAt, githubToken) {
  const deadline = Date.now() + TIMELINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const timeline = await listTimeline(repository, issue, githubToken);
    const match = timeline.filter(
      (event) => Number.isSafeInteger(event.id) && !baseline.has(event.id) && event.event === action && Date.parse(event.created_at ?? "") >= startedAt - 1e4
    ).sort((left, right) => Number(right.id) - Number(left.id))[0];
    if (match) return match;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new WebhookIngressCanaryError(
    "timeline_event_missing",
    `GitHub did not expose the sentinel ${action} timeline event within ${TIMELINE_TIMEOUT_MS / 1e3}s`
  );
}
function deliveryMatchesProbe(delivery, repository, repositoryId, issue, action, updatedAt) {
  const payload = delivery.request?.payload;
  return delivery.event === "issues" && delivery.action === action && delivery.repository_id === repositoryId && payload?.action === action && payload.repository?.id === repositoryId && payload.repository.full_name === repository && payload.issue?.number === issue && payload.issue.updated_at === updatedAt;
}
async function pollAppDelivery(appToken, repository, repositoryId, issue, action, updatedAt, startedAt) {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  const inspected = /* @__PURE__ */ new Set();
  while (Date.now() < deadline) {
    const summaries = await requestJson(
      api("/app/hook/deliveries?per_page=100"),
      appToken,
      {},
      parseAppDeliverySummaries
    );
    const candidates = summaries.filter(
      (delivery) => !inspected.has(delivery.id) && delivery.event === "issues" && delivery.action === action && delivery.repository_id === repositoryId && Date.parse(delivery.delivered_at) >= startedAt - 1e4
    );
    for (const candidate of candidates) {
      inspected.add(candidate.id);
      const detail = await requestJson(
        api(`/app/hook/deliveries/${candidate.id}`),
        appToken
      );
      if (deliveryMatchesProbe(
        detail,
        repository,
        repositoryId,
        issue,
        action,
        updatedAt
      )) {
        return detail;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new WebhookIngressCanaryError(
    "no_delivery",
    `No matching GitHub App delivery appeared within ${DELIVERY_TIMEOUT_MS / 1e3}s`
  );
}
function classifyDeliveryFailure(delivery) {
  const status = delivery.status_code ?? 0;
  if (status >= 200 && status <= 299) return void 0;
  const response = JSON.stringify(delivery.response?.payload ?? "");
  const category = response.includes("Hosted admission enqueue failed") ? "enqueue_failure" : status === 401 ? "delivery_hmac_rejected" : "delivery_rejected";
  return new WebhookIngressCanaryError(
    category,
    `GitHub delivery ${delivery.guid} received HTTP ${status} from the public ingress`
  );
}
async function actionsOidcToken(audience) {
  const requestUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL");
  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    `${requestUrl}${separator}audience=${encodeURIComponent(audience)}`,
    {
      headers: {
        Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`
      }
    }
  );
  if (!response.ok) {
    throw new Error(
      `GitHub Actions OIDC request failed with HTTP ${response.status}`
    );
  }
  const token = await response.json();
  if (!token.value)
    throw new Error("GitHub Actions OIDC response omitted value");
  return token.value;
}
async function pollAuthority(token, delivery, issue, action, sourceId) {
  const deadline = Date.now() + AUTHORITY_TIMEOUT_MS;
  let last = { stage: "awaiting-receipt" };
  while (Date.now() < deadline) {
    try {
      const response = await fetch(WEBHOOK_INGRESS_PROBE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          deliveryId: delivery.guid,
          issue,
          action,
          sourceId
        })
      });
      if (response.ok) {
        last = await response.json();
        console.log(
          `::notice::webhook ingress probe stage=${last.stage} attempt=${last.processorAttempt ?? "unknown"} controllerRevision=${last.controllerRevision ?? "missing"}`
        );
        if (last.stage === "success") return last;
      } else {
        console.log(
          `::warning::webhook ingress authority probe returned HTTP ${response.status}`
        );
      }
    } catch (error) {
      console.log(
        `::warning::webhook ingress authority probe request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const category = last.stage === "repeated-processor-failure" ? "repeated_processor_failure" : last.stage === "processor-failed" ? "processor_failure" : "missing_durable_observation";
  throw new WebhookIngressCanaryError(
    category,
    `Exact event-originated authority evidence did not appear within ${AUTHORITY_TIMEOUT_MS / 1e3}s (last stage: ${last.stage})`
  );
}
async function runWebhookIngressCanary() {
  const repository = required("GITHUB_REPOSITORY");
  const repositoryId = Number(required("GITHUB_REPOSITORY_ID"));
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("GITHUB_REPOSITORY_ID is invalid");
  }
  const githubToken = required("GITHUB_TOKEN");
  const appToken = createAppJwt(
    required("APP_CLIENT_ID"),
    required("APP_PRIVATE_KEY")
  );
  const sentinel = await findOrCreateSentinel(repository, githubToken);
  output("issue", sentinel.number);
  const baseline = new Set(
    (await listTimeline(repository, sentinel.number, githubToken)).map((event) => event.id).filter((id) => Number.isSafeInteger(id))
  );
  const action = sentinel.state === "open" ? "closed" : "reopened";
  const targetState = action === "closed" ? "closed" : "open";
  const startedAt = Date.now();
  const mutated = await requestJson(
    api(`/repos/${repository}/issues/${sentinel.number}`),
    githubToken,
    {
      method: "PATCH",
      body: JSON.stringify({ state: targetState })
    }
  );
  const timeline = await pollTimelineEvent(
    repository,
    sentinel.number,
    action,
    baseline,
    startedAt,
    githubToken
  );
  const sourceId = `timeline:${timeline.id}`;
  const delivery = await pollAppDelivery(
    appToken,
    repository,
    repositoryId,
    sentinel.number,
    action,
    mutated.updated_at,
    startedAt
  );
  const deliveryFailure = classifyDeliveryFailure(delivery);
  if (deliveryFailure) throw deliveryFailure;
  const authority = await pollAuthority(
    await actionsOidcToken(WEBHOOK_INGRESS_CANARY_OIDC_AUDIENCE),
    delivery,
    sentinel.number,
    action,
    sourceId
  );
  console.log(
    `Webhook ingress verified for #${sentinel.number}: action=${action} source=${sourceId} delivery=${delivery.guid} controllerRevision=${authority.controllerRevision}.`
  );
}
async function main() {
  try {
    await runWebhookIngressCanary();
    output("failure-category", "");
    output("failure-detail", "");
  } catch (error) {
    const category = error instanceof WebhookIngressCanaryError ? error.category : "canary_internal_error";
    const message = error instanceof Error ? error.message : String(error);
    output("failure-category", category);
    output("failure-detail", message);
    console.error(`::error title=Webhook ingress ${category}::${message}`);
    process.exitCode = 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
export {
  WebhookIngressCanaryError,
  assertSentinelSafe,
  classifyDeliveryFailure,
  createAppJwt,
  deliveryMatchesProbe,
  parseAppDeliverySummaries,
  runWebhookIngressCanary
};
