export const CLOUDFLARE_PROJECT_FILE = "cloudflare.project.json";
export const CLOUDFLARE_CONFIG_FILE = "cloudflare.config.ts";
/** Where `cf workers types` and `cf build` (the Cloudflare Vite plugin) write, relative to the project. */
export const CF_OUTPUT_DIR = ".cloudflare";
export const CF_GENERATED_BINDING_TYPES = `${CF_OUTPUT_DIR}/types/index.d.ts`;
const CF_BUILD_OUTPUT_WORKER_ROOT = `${CF_OUTPUT_DIR}/output/v0/workers/default`;
export const CF_BUILT_WORKER_MODULE = `${CF_BUILD_OUTPUT_WORKER_ROOT}/bundle/index.js`;
export const CF_BUILT_ASSETS_DIR = `${CF_BUILD_OUTPUT_WORKER_ROOT}/assets`;
export const CF_BUILD_OUTPUT_WORKER_CONFIG = `${CF_BUILD_OUTPUT_WORKER_ROOT}/worker.config.json`;
/** Deployment policy the rendered config carries; the control plane's runtime policy must match it. */
export const CF_COMPATIBILITY_DATE = "2026-07-21";
export const CF_LOGS_HEAD_SAMPLING_RATE = 0.6;
export const CF_TRACES_HEAD_SAMPLING_RATE = 0.05;
export const PLACEHOLDER_D1_DATABASE_ID =
  "00000000-0000-0000-0000-000000000000";
export const PLACEHOLDER_KV_NAMESPACE_ID = "00000000000000000000000000000000";
const WORKER_ENTRYPOINTS = ["src/plain-server.ts", "src/server.ts"];

const cloudflareName = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const D1_DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const KV_NAMESPACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The Cloudflare resources a generated project deploys with, as plain data.
 *
 * `cloudflare.config.ts` is rendered from this file so provisioning, the Agent
 * capability, and CloudChef's control plane read and write JSON rather than
 * executable configuration. Every field is validated before it is rendered.
 * This module is pure so the control plane can validate a project with it.
 */
export function parseCloudflareProject(value) {
  const errors = [];
  const record = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    errors.push(`${CLOUDFLARE_PROJECT_FILE} must contain a JSON object.`);
  }
  const allowed = new Set(["name", "entrypoint", "d1", "kv", "r2", "agent"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(
        `${CLOUDFLARE_PROJECT_FILE} has unsupported key ${JSON.stringify(key)}.`,
      );
    }
  }
  requireMatch(errors, record.name, cloudflareName, "name");
  if (!WORKER_ENTRYPOINTS.includes(record.entrypoint)) {
    errors.push(
      `${CLOUDFLARE_PROJECT_FILE} entrypoint must be one of ${WORKER_ENTRYPOINTS.join(", ")}.`,
    );
  }
  if (record.d1 !== undefined) {
    requireD1(errors, record.d1, "d1");
  }
  if (record.kv !== undefined) {
    requireExactKeys(errors, record.kv, ["id"], "kv");
    requireMatch(errors, record.kv?.id, KV_NAMESPACE_ID_PATTERN, "kv.id");
  }
  if (record.r2 !== undefined) {
    requireExactKeys(errors, record.r2, ["name"], "r2");
    requireMatch(errors, record.r2?.name, cloudflareName, "r2.name");
  }
  if (record.agent !== undefined) {
    requireExactKeys(errors, record.agent, ["securityD1"], "agent");
    requireD1(errors, record.agent?.securityD1, "agent.securityD1");
    if (record.entrypoint !== "src/server.ts") {
      errors.push(
        `${CLOUDFLARE_PROJECT_FILE} agent requires entrypoint "src/server.ts".`,
      );
    }
    const agentDatabaseId = record.agent?.securityD1?.id;
    if (
      agentDatabaseId !== PLACEHOLDER_D1_DATABASE_ID &&
      agentDatabaseId === record.d1?.id
    ) {
      errors.push(
        `${CLOUDFLARE_PROJECT_FILE} d1 and agent.securityD1 must be separate databases.`,
      );
    }
  }
  return { project: record, errors };
}

/** Parse the file's text: invalid JSON is reported as an error like any other. */
export function parseCloudflareProjectText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      project: {},
      errors: [
        `${CLOUDFLARE_PROJECT_FILE} is not valid JSON: ${error.message}`,
      ],
    };
  }
  return parseCloudflareProject(value);
}

/** Render literal configuration so `cf workers types` infers exact binding types. */
export function renderCloudflareConfig(project) {
  const agent = project.agent;
  const env = [];
  if (project.d1) {
    env.push(`DB: bindings.d1(${literal(project.d1)}),`);
  }
  if (agent) {
    env.push(`AGENT_SECURITY_DB: bindings.d1(${literal(agent.securityD1)}),`);
  }
  if (project.kv) {
    env.push(`APP_CACHE: bindings.kv(${literal(project.kv)}),`);
  }
  if (project.r2) {
    env.push(`APP_STORAGE: bindings.r2(${literal(project.r2)}),`);
  }
  if (agent) {
    env.push(
      `AppAgent: bindings.durableObject(${literal({ worker: project.name, exportName: "AppAgent" })}),`,
      "AI: bindings.ai({}),",
    );
  }
  const imports = agent
    ? "bindings, defineConfig, exports, triggers"
    : "bindings, defineConfig";
  const worker = [
    `name: ${literal(project.name)},`,
    `compatibilityDate: ${literal(CF_COMPATIBILITY_DATE)},`,
    'compatibilityFlags: ["nodejs_compat"],',
    `entrypoint: ${literal(project.entrypoint)},`,
    "observability: {",
    "  enabled: true,",
    `  logs: { enabled: true, headSamplingRate: ${CF_LOGS_HEAD_SAMPLING_RATE} },`,
    `  traces: { enabled: true, headSamplingRate: ${CF_TRACES_HEAD_SAMPLING_RATE} },`,
    "},",
    ...(agent
      ? [
          'exports: { AppAgent: exports.durableObject({ storage: "sqlite" }) },',
          'triggers: [triggers.scheduled({ schedule: "0 3 * * *" })],',
        ]
      : []),
    "env: {",
    ...env.map((line) => `  ${line}`),
    "},",
  ];
  return [
    `// Generated from ${CLOUDFLARE_PROJECT_FILE} by scripts/render-cloudflare-config.mjs. Do not edit.`,
    `import { ${imports} } from "cf/config";`,
    "",
    "export default defineConfig({",
    "  worker: {",
    ...worker.map((line) => `    ${line}`),
    "  },",
    "});",
    "",
  ].join("\n");
}

function literal(value) {
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${key}: ${JSON.stringify(item)}`)
    .join(", ")} }`;
}

function requireD1(errors, value, label) {
  requireExactKeys(errors, value, ["name", "id"], label);
  requireMatch(errors, value?.name, cloudflareName, `${label}.name`);
  requireMatch(errors, value?.id, D1_DATABASE_ID_PATTERN, `${label}.id`);
}

function requireExactKeys(errors, value, keys, label) {
  if (!isRecord(value)) {
    errors.push(`${CLOUDFLARE_PROJECT_FILE} ${label} must be an object.`);
    return;
  }
  const actual = Object.keys(value).sort().join(",");
  if (actual !== [...keys].sort().join(",")) {
    errors.push(
      `${CLOUDFLARE_PROJECT_FILE} ${label} must contain exactly ${keys.join(", ")}.`,
    );
  }
}

function requireMatch(errors, value, pattern, label) {
  // JSON.parse yields only primitives, arrays, and plain objects; only a string equals its own coercion.
  if (value !== String(value) || !pattern.test(value)) {
    errors.push(`${CLOUDFLARE_PROJECT_FILE} ${label} is invalid.`);
  }
}

function isRecord(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}
