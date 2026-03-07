#!/usr/bin/env node

import { mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE = "2026-03-01";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function must(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function generateFederationPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOrCreateSecretMaterial(path, createValue, rotate) {
  if (!rotate && await fileExists(path)) {
    const existing = await readFile(path, "utf8");
    const normalized = existing.trim();
    if (normalized) return { value: normalized, reused: true };
  }

  const value = createValue();
  await writeFile(path, `${value}\n`);
  return { value, reused: false };
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeSmtpConfig(args) {
  const config = {
    host: (args["smtp-host"] ? String(args["smtp-host"]) : (process.env.SMTP_HOST || "")).trim(),
    port: (args["smtp-port"] ? String(args["smtp-port"]) : (process.env.SMTP_PORT || "")).trim(),
    from: (args["smtp-from"] ? String(args["smtp-from"]) : (process.env.SMTP_FROM || "")).trim(),
    secure: (args["smtp-secure"] ? String(args["smtp-secure"]) : (process.env.SMTP_SECURE || "false")).trim(),
    user: (args["smtp-user"] ? String(args["smtp-user"]) : (process.env.SMTP_USER || "")).trim(),
    pass: (args["smtp-pass"] ? String(args["smtp-pass"]) : (process.env.SMTP_PASS || "")).trim(),
  };
  return config;
}

async function verifySmtpReachability(host, port, timeoutMs = 4000) {
  await lookup(host);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs }, () => {
      socket.end();
      resolve(undefined);
    });
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("smtp_timeout"));
    });
  });
}

async function validateSmtpConfig(config, options) {
  const messages = [];
  const configured = Boolean(config.host && config.port && config.from);
  if (!configured) {
    if (options.allowNoSmtp) {
      return { configured: false, valid: true, messages: ["SMTP optional mode enabled; skipping SMTP validation."] };
    }
    throw new Error("SMTP is required for production bootstrap. Provide --smtp-host, --smtp-port, --smtp-from (and optional auth). Use --allow-no-smtp only for non-production/testing.");
  }

  const port = Number.parseInt(config.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SMTP port: ${config.port}`);
  }
  if (!isValidEmail(config.from)) {
    throw new Error(`Invalid SMTP from address: ${config.from}`);
  }
  if (!["true", "false"].includes(config.secure.toLowerCase())) {
    throw new Error("SMTP secure flag must be true or false.");
  }

  if (!options.skipSmtpConnectionCheck) {
    await verifySmtpReachability(config.host, port);
    messages.push("SMTP DNS + TCP reachability check passed.");
  } else {
    messages.push("SMTP connection check skipped by flag.");
  }

  return { configured: true, valid: true, messages };
}

async function runCommandCapture(cmd, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (options.stdinText) {
      child.stdin.write(options.stdinText);
      child.stdin.end();
    }
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}\n${stderr || stdout}`));
    });
    child.on("error", (error) => {
      reject(new Error(`${cmd} ${args.join(" ")} failed to start: ${error.message}`));
    });
  });
}

function parseMaybeJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const firstArray = trimmed.indexOf("[");
  const firstObject = trimmed.indexOf("{");
  const start = firstArray === -1 ? firstObject : (firstObject === -1 ? firstArray : Math.min(firstArray, firstObject));
  if (start === -1) return null;
  const jsonCandidate = trimmed.slice(start);
  return JSON.parse(jsonCandidate);
}

function wranglerEnv(accountId) {
  if (!accountId) return process.env;
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
}

async function runWranglerJson(args, options = {}) {
  try {
    const { stdout } = await runCommandCapture("wrangler", [...args, "--json"], { env: wranglerEnv(options.accountId) });
    const parsed = parseMaybeJsonOutput(stdout);
    if (parsed === null) throw new Error(`Expected JSON output from wrangler ${args.join(" ")}`);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unknown argument: json") && !message.includes("Unknown arguments: json")) {
      throw error;
    }

    const fallback = await runCommandCapture("wrangler", args, { env: wranglerEnv(options.accountId) });
    const parsed = parseMaybeJsonOutput(fallback.stdout) ?? parseMaybeJsonOutput(fallback.stderr);
    if (parsed !== null) return parsed;

    throw new Error(
      `Wrangler command '${args.join(" ")}' does not support --json and did not emit machine-readable output. ` +
      "Upgrade Wrangler (recommended) or run bootstrap with --auth api-token."
    );
  }
}

async function runWrangler(args, options = {}) {
  return await runCommandCapture("wrangler", args, { env: wranglerEnv(options.accountId) });
}

async function cfFetch(path, init, token) {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.success === false) {
    const err = JSON.stringify(payload?.errors || payload || {}, null, 2);
    throw new Error(`Cloudflare API ${path} failed (${res.status}): ${err}`);
  }
  return payload.result;
}

async function resolveAccountId(token, preferredAccountId) {
  if (preferredAccountId) return preferredAccountId;
  const memberships = await cfFetch("/memberships", { method: "GET" }, token);
  const first = Array.isArray(memberships) ? memberships[0] : null;
  if (!first?.account?.id) throw new Error("Unable to resolve account id from token. Provide --account-id.");
  return first.account.id;
}

async function resolveAccountIdFromWrangler(preferredAccountId) {
  const whoami = await runWranglerJson(["whoami"]);
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts : [];
  if (preferredAccountId) {
    const matched = accounts.find((account) => account?.id === preferredAccountId);
    if (!matched) {
      throw new Error(`Account id ${preferredAccountId} not found in Wrangler OAuth session. Run 'wrangler whoami' and choose a listed account id.`);
    }
    return preferredAccountId;
  }
  const first = accounts[0];
  if (!first?.id) throw new Error("Unable to resolve account id from Wrangler OAuth session. Run `wrangler login` or provide --account-id.");
  return first.id;
}

async function ensureD1Database(accountId, name, token) {
  const list = await cfFetch(`/accounts/${accountId}/d1/database`, { method: "GET" }, token);
  const existing = Array.isArray(list) ? list.find((item) => item.name === name) : null;
  if (existing?.uuid) return { id: existing.uuid, created: false };
  const created = await cfFetch(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  }, token);
  return { id: created.uuid, created: true };
}

async function ensureKvNamespace(accountId, title, token) {
  const list = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`, { method: "GET" }, token);
  const existing = Array.isArray(list) ? list.find((item) => item.title === title) : null;
  if (existing?.id) return { id: existing.id, created: false };
  const created = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title }),
  }, token);
  return { id: created.id, created: true };
}

async function ensureR2Bucket(accountId, name, token) {
  const list = await cfFetch(`/accounts/${accountId}/r2/buckets`, { method: "GET" }, token);
  const existing = Array.isArray(list?.buckets) ? list.buckets.find((item) => item.name === name) : null;
  if (existing?.name) return { name: existing.name, created: false };
  await cfFetch(`/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    body: JSON.stringify({ name }),
  }, token);
  return { name, created: true };
}

async function ensureQueue(accountId, queueName, token) {
  const list = await cfFetch(`/accounts/${accountId}/queues`, { method: "GET" }, token);
  const existing = Array.isArray(list) ? list.find((item) => item.queue_name === queueName) : null;
  if (existing?.queue_id) return { id: existing.queue_id, created: false };
  const created = await cfFetch(`/accounts/${accountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: queueName }),
  }, token);
  return { id: created.queue_id, created: true };
}

async function ensureD1DatabaseWithWrangler(accountId, name) {
  const list = await runWranglerJson(["d1", "list"], { accountId });
  const existing = Array.isArray(list) ? list.find((item) => item.name === name) : null;
  if (existing?.uuid) return { id: existing.uuid, created: false };
  await runWrangler(["d1", "create", name], { accountId });
  const refreshed = await runWranglerJson(["d1", "list"], { accountId });
  const created = Array.isArray(refreshed) ? refreshed.find((item) => item.name === name) : null;
  const createdId = created?.uuid || created?.database_id;
  if (!createdId) throw new Error("Unable to parse D1 id from wrangler d1 create output.");
  return { id: createdId, created: true };
}

async function ensureKvNamespaceWithWrangler(accountId, title) {
  const list = await runWranglerJson(["kv", "namespace", "list"], { accountId });
  const existing = Array.isArray(list) ? list.find((item) => item.title === title) : null;
  if (existing?.id) return { id: existing.id, created: false };

  await runWrangler(["kv", "namespace", "create", title], { accountId });
  const refreshed = await runWranglerJson(["kv", "namespace", "list"], { accountId });
  const created = Array.isArray(refreshed) ? refreshed.find((item) => item.title === title) : null;
  const createdId = created?.id;
  if (!createdId) throw new Error("Unable to parse KV namespace id from wrangler kv namespace create output.");
  return { id: createdId, created: true };
}

async function ensureR2BucketWithWrangler(accountId, name) {
  const list = await runWranglerJson(["r2", "bucket", "list"], { accountId });
  const existing = Array.isArray(list) ? list.find((item) => item.name === name) : null;
  if (existing?.name) return { name: existing.name, created: false };
  await runWrangler(["r2", "bucket", "create", name], { accountId });
  return { name, created: true };
}

async function ensureQueueWithWrangler(accountId, queueName) {
  const list = await runWranglerJson(["queues", "list"], { accountId });
  const existing = Array.isArray(list) ? list.find((item) => item.queue_name === queueName || item.queueName === queueName) : null;
  if (existing?.queue_id || existing?.queueId) return { id: existing.queue_id || existing.queueId, created: false };
  await runWrangler(["queues", "create", queueName], { accountId });
  const refreshed = await runWranglerJson(["queues", "list"], { accountId });
  const created = Array.isArray(refreshed) ? refreshed.find((item) => item.queue_name === queueName || item.queueName === queueName) : null;
  return { id: created?.queue_id || created?.queueId || "", created: true };
}

async function runCommand(cmd, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "inherit", "inherit"], ...options });
    if (options.stdinText) {
      child.stdin.write(options.stdinText);
      child.stdin.end();
    }
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", (error) => {
      reject(new Error(`${cmd} ${args.join(" ")} failed to start: ${error.message}`));
    });
  });
}

async function putWranglerSecret(name, value, workerConfigPath) {
  await runCommand("wrangler", ["secret", "put", name, "--config", workerConfigPath], { stdinText: `${value}\n` });
}

async function putWorkerNamedSecret(workerName, secretName, value) {
  await runCommand("wrangler", ["secret", "put", secretName, "--name", workerName], { stdinText: `${value}\n` });
}

function renderCompanionWorkerSource(jobType) {
  return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      const ok = Boolean(env.TARGET_WEBHOOK_URL && String(env.TARGET_WEBHOOK_URL).trim());
      return new Response(JSON.stringify({ ok, mode: "webhook-forward" }), {
        status: ok ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (url.pathname !== "/jobs/${jobType}") return new Response("Not Found", { status: 404 });

    const target = env.TARGET_WEBHOOK_URL ? String(env.TARGET_WEBHOOK_URL).trim() : "";
    if (!target) {
      return new Response(JSON.stringify({ error: "missing_target_webhook_url" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const raw = await request.text();
    const headers = { "content-type": "application/json" };
    if (env.JOBS_WEBHOOK_TOKEN) headers.authorization = "Bearer " + env.JOBS_WEBHOOK_TOKEN;

    const parsed = raw ? JSON.parse(raw) : {};
    const res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...parsed, source: "cloudflare-companion-${jobType}" }),
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: "executor_failed", status: res.status }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, worker: jobType }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  },
};
`;
}

function renderWorkerConfig(input) {
  return `name = "${input.workerName}"
main = "packages/cloudflare-worker/src/index.ts"
compatibility_date = "${COMPATIBILITY_DATE}"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "${input.d1Name}"
database_id = "${input.d1Id}"
migrations_dir = "packages/cloudflare-worker/migrations"

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "${input.r2Bucket}"

[[queues.producers]]
binding = "JOBS_QUEUE"
queue = "${input.queueName}"

[[queues.consumers]]
queue = "${input.queueName}"
max_batch_size = 10
max_batch_timeout = 10

[[kv_namespaces]]
binding = "RATE_LIMITS_KV"
id = "${input.kvId}"

[[durable_objects.bindings]]
name = "RATE_LIMITS_DO"
class_name = "RateLimitCoordinator"

[[migrations]]
tag = "v1"
new_classes = ["RateLimitCoordinator"]

[[services]]
binding = "REMINDERS_SERVICE"
service = "${input.remindersService}"

[[services]]
binding = "SCRAPERS_SERVICE"
service = "${input.scrapersService}"

[triggers]
crons = ["0 * * * *"]

[vars]
BASE_URL = "${input.apiOrigin}"
SESSION_COOKIE_NAME = "everycal_session"
CORS_ORIGIN = "${input.webOrigin}"
SSR_CACHE_MAX_AGE_SECONDS = "15"
SSR_CACHE_STALE_WHILE_REVALIDATE_SECONDS = "30"
SSR_EDGE_CACHE_ENABLED = "true"
SSR_EDGE_CACHE_BYPASS_HEADER = "x-everycal-ssr-bypass"
SSR_CACHE_TAG_VERSION = "v1"

[observability]
enabled = true
`;
}

function renderPagesConfig(apiOrigin) {
  return `name = "everycal-web"
compatibility_date = "${COMPATIBILITY_DATE}"
pages_build_output_dir = "dist/client"

[vars]
API_ORIGIN = "${apiOrigin}"
VITE_API_ORIGIN = "${apiOrigin}"
`;
}

async function verifyGeneratedConfig(workerConfigPath, pagesConfigPath) {
  await runCommand("node", [
    "scripts/cf-deploy-readiness.mjs",
    "--worker-config", workerConfigPath,
    "--pages-config", pagesConfigPath,
  ]);
}

async function verifyRemoteReadiness(apiOrigin) {
  const url = `${apiOrigin}/api/v1/system/deploy-readiness`;
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok !== true) {
    throw new Error(`Remote readiness check failed at ${url}: ${JSON.stringify(payload)}`);
  }
}

async function deployCompanionWorker(name, scriptPath, webhookUrl) {
  const args = [
    "deploy",
    scriptPath,
    "--name",
    name,
    "--compatibility-date",
    COMPATIBILITY_DATE,
  ];
  if (webhookUrl) args.push("--var", `TARGET_WEBHOOK_URL:${webhookUrl}`);
  await runCommand("wrangler", args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = must(args.domain, "Missing required --domain (example: --domain calendar.example.com)");
  const env = String(args.env || "prod");
  const projectSlug = slugify(String(args.project || "everycal"));
  const workerName = `${projectSlug}-${env}`;
  const pagesProject = String(args["pages-project"] || "everycal-web");
  const apiHost = String(args["api-host"] || `api.${domain}`);
  const webOrigin = `https://${domain}`;
  const apiOrigin = `https://${apiHost}`;
  const dryRun = !args.apply;
  const shouldDeploy = Boolean(args.deploy);
  const shouldSetSecrets = !args["skip-secrets"];
  const shouldVerifyGenerated = !args["skip-config-check"];
  const shouldVerifyRemote = shouldDeploy && !args["skip-remote-verify"];
  const shouldProvisionCompanionWorkers = !args["skip-companion-workers"];
  const shouldRotateKeys = Boolean(args["rotate-keys"]);
  const shouldWriteTrackedConfigs = Boolean(args["write-tracked-configs"]);
  const remindersWebhookUrl = args["reminders-webhook-url"] ? String(args["reminders-webhook-url"]) : "";
  const scrapersWebhookUrl = args["scrapers-webhook-url"] ? String(args["scrapers-webhook-url"]) : "";
  const allowNoSmtp = Boolean(args["allow-no-smtp"]);
  const skipSmtpConnectionCheck = Boolean(args["skip-smtp-connection-check"]);
  const smtpConfig = normalizeSmtpConfig(args);

  const d1Name = `${projectSlug}-${env}`;
  const kvTitle = `${projectSlug}-${env}-rate-limits`;
  const r2Bucket = `${projectSlug}-${env}-uploads`;
  const queueName = `${projectSlug}-${env}-jobs`;
  const remindersService = `${projectSlug}-reminders-${env}`;
  const scrapersService = `${projectSlug}-scrapers-${env}`;

  const smtpValidation = dryRun
    ? { configured: Boolean(smtpConfig.host && smtpConfig.port && smtpConfig.from), valid: true, messages: ["Plan mode: SMTP validation deferred to apply mode."] }
    : await validateSmtpConfig(smtpConfig, { allowNoSmtp, skipSmtpConnectionCheck });

  const summary = {
    mode: dryRun ? "plan" : "apply",
    input: { domain, apiHost, env, projectSlug, pagesProject, authMode: String(args.auth || process.env.CF_BOOTSTRAP_AUTH || "oauth").toLowerCase(), remindersWebhookUrl, scrapersWebhookUrl, smtp: { host: smtpConfig.host, port: smtpConfig.port, from: smtpConfig.from, secure: smtpConfig.secure, hasAuth: Boolean(smtpConfig.user && smtpConfig.pass) } },
    derived: {
      webOrigin,
      apiOrigin,
      workerName,
      d1Name,
      kvTitle,
      r2Bucket,
      queueName,
      remindersService,
      scrapersService,
    },
    execution: {
      shouldSetSecrets,
      shouldDeploy,
      shouldVerifyGenerated,
      shouldVerifyRemote,
      shouldProvisionCompanionWorkers,
      shouldRotateKeys,
      shouldWriteTrackedConfigs,
      remindersWebhookConfigured: Boolean(remindersWebhookUrl),
      scrapersWebhookConfigured: Boolean(scrapersWebhookUrl),
      smtpConfigured: smtpValidation.configured,
      smtpValidationMessages: smtpValidation.messages,
    },
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nPlan mode only. Re-run with --apply to provision resources and write generated config files.");
    return;
  }

  if (smtpValidation.configured) {
    console.log(`[bootstrap] SMTP validated for ${smtpConfig.host}:${smtpConfig.port} (${smtpConfig.from}).`);
  }

  const preferredAccountId = args["account-id"] ? String(args["account-id"]) : undefined;
  const authMode = String(args.auth || process.env.CF_BOOTSTRAP_AUTH || "oauth").toLowerCase();
  let accountId;
  let d1;
  let kv;
  let r2;
  let queue;

  if (authMode === "api-token") {
    const token = must(process.env.CLOUDFLARE_API_TOKEN, "Missing CLOUDFLARE_API_TOKEN for --auth api-token mode.");
    accountId = await resolveAccountId(token, preferredAccountId);
    d1 = await ensureD1Database(accountId, d1Name, token);
    kv = await ensureKvNamespace(accountId, kvTitle, token);
    r2 = await ensureR2Bucket(accountId, r2Bucket, token);
    queue = await ensureQueue(accountId, queueName, token);
  } else {
    accountId = await resolveAccountIdFromWrangler(preferredAccountId);
    d1 = await ensureD1DatabaseWithWrangler(accountId, d1Name);
    kv = await ensureKvNamespaceWithWrangler(accountId, kvTitle);
    r2 = await ensureR2BucketWithWrangler(accountId, r2Bucket);
    queue = await ensureQueueWithWrangler(accountId, queueName);
  }

  await mkdir(".generated", { recursive: true });

  const privateKeyPath = `.generated/activitypub-private-key.${env}.pem`;
  const jobsTokenPath = `.generated/jobs-webhook-token.${env}.txt`;
  const privateKey = await resolveOrCreateSecretMaterial(privateKeyPath, generateFederationPrivateKeyPem, shouldRotateKeys);
  const jobsToken = await resolveOrCreateSecretMaterial(jobsTokenPath, () => randomBytes(24).toString("hex"), shouldRotateKeys);

  const workerConfigPath = `.generated/wrangler.${env}.toml`;
  const pagesConfigPath = `.generated/packages.web.wrangler.${env}.toml`;
  await writeFile(workerConfigPath, renderWorkerConfig({
    workerName,
    d1Name,
    d1Id: d1.id,
    r2Bucket: r2.name,
    queueName,
    kvId: kv.id,
    remindersService,
    scrapersService,
    webOrigin,
    apiOrigin,
  }));
  await writeFile(pagesConfigPath, renderPagesConfig(apiOrigin));

  if (shouldWriteTrackedConfigs) {
    await copyFile(workerConfigPath, "wrangler.toml");
    await copyFile(pagesConfigPath, "packages/web/wrangler.toml");
  }

  const remindersCompanionPath = `.generated/companion-${remindersService}.mjs`;
  const scrapersCompanionPath = `.generated/companion-${scrapersService}.mjs`;
  await writeFile(remindersCompanionPath, renderCompanionWorkerSource("reminders"));
  await writeFile(scrapersCompanionPath, renderCompanionWorkerSource("scrapers"));

  const receipt = {
    ...summary,
    accountId,
    resources: {
      d1: { ...d1, name: d1Name },
      kv: { ...kv, title: kvTitle },
      r2: { ...r2 },
      queue: { ...queue, name: queueName },
      companionServices: {
        reminders: { name: remindersService, scriptPath: remindersCompanionPath },
        scrapers: { name: scrapersService, scriptPath: scrapersCompanionPath },
      },
    },
    generated: {
      workerConfigPath,
      pagesConfigPath,
      activityPubPrivateKeyPemPath: privateKeyPath,
      jobsWebhookTokenPath: jobsTokenPath,
    },
    secretReuse: {
      federationKeyReused: privateKey.reused,
      jobsWebhookTokenReused: jobsToken.reused,
    },
    smtp: {
      ...smtpValidation,
      host: smtpConfig.host,
      port: smtpConfig.port,
      from: smtpConfig.from,
      secure: smtpConfig.secure,
      hasAuth: Boolean(smtpConfig.user && smtpConfig.pass),
    },
  };

  const receiptPath = `.generated/cf-bootstrap-receipt.${env}.json`;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));

  console.log("Created resources and generated config files:");
  console.log(`- ${workerConfigPath}`);
  console.log(`- ${pagesConfigPath}`);
  console.log(`- ${receiptPath}`);

  if (shouldVerifyGenerated) {
    console.log("\nRunning strict generated-config readiness checks...");
    await verifyGeneratedConfig(workerConfigPath, pagesConfigPath);
  }

  if (shouldSetSecrets) {
    console.log("\nSetting Worker secrets...");
    await putWranglerSecret("ACTIVITYPUB_PRIVATE_KEY_PEM", privateKey.value, workerConfigPath);
    await putWranglerSecret("JOBS_WEBHOOK_TOKEN", jobsToken.value, workerConfigPath);
    if (smtpValidation.configured) {
      await putWranglerSecret("SMTP_HOST", smtpConfig.host, workerConfigPath);
      await putWranglerSecret("SMTP_PORT", smtpConfig.port, workerConfigPath);
      await putWranglerSecret("SMTP_FROM", smtpConfig.from, workerConfigPath);
      await putWranglerSecret("SMTP_SECURE", smtpConfig.secure, workerConfigPath);
      if (smtpConfig.user && smtpConfig.pass) {
        await putWranglerSecret("SMTP_USER", smtpConfig.user, workerConfigPath);
        await putWranglerSecret("SMTP_PASS", smtpConfig.pass, workerConfigPath);
      }
    }
  }

  if (shouldProvisionCompanionWorkers && (!remindersWebhookUrl || !scrapersWebhookUrl)) {
    console.warn("\n[bootstrap] Companion workers are deployed without one or more TARGET_WEBHOOK_URL values.");
    console.warn("[bootstrap] Set --reminders-webhook-url/--scrapers-webhook-url for behavioral executor readiness.");
  }

  if (shouldDeploy) {
    if (shouldProvisionCompanionWorkers) {
      console.log("\nDeploying companion service workers (reminders/scrapers)...");
      await deployCompanionWorker(remindersService, remindersCompanionPath, remindersWebhookUrl);
      await deployCompanionWorker(scrapersService, scrapersCompanionPath, scrapersWebhookUrl);

      if (shouldSetSecrets) {
        await putWorkerNamedSecret(remindersService, "JOBS_WEBHOOK_TOKEN", jobsToken.value);
        await putWorkerNamedSecret(scrapersService, "JOBS_WEBHOOK_TOKEN", jobsToken.value);
        if (smtpValidation.configured) {
          await putWorkerNamedSecret(remindersService, "SMTP_HOST", smtpConfig.host);
          await putWorkerNamedSecret(remindersService, "SMTP_PORT", smtpConfig.port);
          await putWorkerNamedSecret(remindersService, "SMTP_FROM", smtpConfig.from);
          await putWorkerNamedSecret(remindersService, "SMTP_SECURE", smtpConfig.secure);
          await putWorkerNamedSecret(scrapersService, "SMTP_HOST", smtpConfig.host);
          await putWorkerNamedSecret(scrapersService, "SMTP_PORT", smtpConfig.port);
          await putWorkerNamedSecret(scrapersService, "SMTP_FROM", smtpConfig.from);
          await putWorkerNamedSecret(scrapersService, "SMTP_SECURE", smtpConfig.secure);
          if (smtpConfig.user && smtpConfig.pass) {
            await putWorkerNamedSecret(remindersService, "SMTP_USER", smtpConfig.user);
            await putWorkerNamedSecret(remindersService, "SMTP_PASS", smtpConfig.pass);
            await putWorkerNamedSecret(scrapersService, "SMTP_USER", smtpConfig.user);
            await putWorkerNamedSecret(scrapersService, "SMTP_PASS", smtpConfig.pass);
          }
        }
      }
    }

    console.log("\nDeploying EveryCal Worker + Pages...");
    await runCommand("wrangler", ["d1", "migrations", "apply", d1Name, "--config", workerConfigPath]);
    await runCommand("wrangler", ["deploy", "--config", workerConfigPath]);
    await runCommand("pnpm", ["cf:pages:build"]);
    await runCommand("wrangler", ["pages", "deploy", "packages/web/dist/client", "--project-name", pagesProject, "--config", pagesConfigPath]);

    if (shouldVerifyRemote) {
      console.log("\nVerifying remote runtime readiness endpoint...");
      await verifyRemoteReadiness(apiOrigin);
      console.log("Remote readiness check passed.");
    }
  }

  console.log("\nNext steps:");
  console.log(`- Review ${receiptPath} for created resource IDs and generated artifacts.`);
  if (!shouldSetSecrets) {
    console.log("- Set secrets manually:");
    console.log(`  wrangler secret put ACTIVITYPUB_PRIVATE_KEY_PEM --config ${workerConfigPath} < ${privateKeyPath}`);
    console.log(`  wrangler secret put JOBS_WEBHOOK_TOKEN --config ${workerConfigPath} < ${jobsTokenPath}`);
  }
  if (!shouldDeploy) {
    console.log("- Deploy manually:");
    if (shouldProvisionCompanionWorkers) {
      console.log(`  wrangler deploy ${remindersCompanionPath} --name ${remindersService} --compatibility-date ${COMPATIBILITY_DATE} --var TARGET_WEBHOOK_URL:${remindersWebhookUrl || "<set reminders webhook url>"}`);
      console.log(`  wrangler deploy ${scrapersCompanionPath} --name ${scrapersService} --compatibility-date ${COMPATIBILITY_DATE} --var TARGET_WEBHOOK_URL:${scrapersWebhookUrl || "<set scrapers webhook url>"}`);
    }
    console.log(`  wrangler d1 migrations apply ${d1Name} --config ${workerConfigPath}`);
    console.log(`  wrangler deploy --config ${workerConfigPath}`);
    console.log("  pnpm cf:pages:build");
    console.log(`  wrangler pages deploy packages/web/dist/client --project-name ${pagesProject} --config ${pagesConfigPath}`);
  }
  if (!shouldVerifyRemote) {
    console.log("- Verify runtime readiness:");
    console.log(`  curl -fsS ${apiOrigin}/api/v1/system/deploy-readiness`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
