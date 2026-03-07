#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

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
  });
}

function renderWorkerConfig(input) {
  return `name = "everycal"
main = "packages/cloudflare-worker/src/index.ts"
compatibility_date = "2026-03-01"
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
compatibility_date = "2026-03-01"
pages_build_output_dir = "dist/client"

[vars]
API_ORIGIN = "${apiOrigin}"
VITE_API_ORIGIN = "${apiOrigin}"
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = must(args.domain, "Missing required --domain (example: --domain calendar.example.com)");
  const env = String(args.env || "prod");
  const projectSlug = slugify(String(args.project || "everycal"));
  const apiHost = String(args["api-host"] || `api.${domain}`);
  const webOrigin = `https://${domain}`;
  const apiOrigin = `https://${apiHost}`;
  const dryRun = !args.apply;

  const d1Name = `${projectSlug}-${env}`;
  const kvTitle = `${projectSlug}-${env}-rate-limits`;
  const r2Bucket = `${projectSlug}-${env}-uploads`;
  const queueName = `${projectSlug}-${env}-jobs`;
  const remindersService = `${projectSlug}-reminders-${env}`;
  const scrapersService = `${projectSlug}-scrapers-${env}`;

  const summary = {
    mode: dryRun ? "plan" : "apply",
    input: { domain, apiHost, env, projectSlug },
    derived: { webOrigin, apiOrigin, d1Name, kvTitle, r2Bucket, queueName, remindersService, scrapersService },
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nPlan mode only. Re-run with --apply to provision resources and write generated config files.");
    return;
  }

  const token = must(process.env.CLOUDFLARE_API_TOKEN, "Missing CLOUDFLARE_API_TOKEN for --apply mode.");
  const accountId = await resolveAccountId(token, args["account-id"] ? String(args["account-id"]) : undefined);

  const d1 = await ensureD1Database(accountId, d1Name, token);
  const kv = await ensureKvNamespace(accountId, kvTitle, token);
  const r2 = await ensureR2Bucket(accountId, r2Bucket, token);
  await ensureQueue(accountId, queueName, token);

  const activityPubPrivateKeyPem = generateFederationPrivateKeyPem();
  const jobsWebhookToken = randomBytes(24).toString("hex");

  await mkdir(".generated", { recursive: true });

  const workerConfigPath = `.generated/wrangler.${env}.toml`;
  const pagesConfigPath = `.generated/packages.web.wrangler.${env}.toml`;
  await writeFile(workerConfigPath, renderWorkerConfig({
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

  const receipt = {
    ...summary,
    accountId,
    resources: {
      d1: { ...d1, name: d1Name },
      kv: { ...kv, title: kvTitle },
      r2: { ...r2 },
      queue: { name: queueName },
    },
    generated: {
      workerConfigPath,
      pagesConfigPath,
      activityPubPrivateKeyPemPath: `.generated/activitypub-private-key.${env}.pem`,
      jobsWebhookTokenPath: `.generated/jobs-webhook-token.${env}.txt`,
    },
  };

  await writeFile(`.generated/activitypub-private-key.${env}.pem`, activityPubPrivateKeyPem);
  await writeFile(`.generated/jobs-webhook-token.${env}.txt`, `${jobsWebhookToken}\n`);
  await writeFile(`.generated/cf-bootstrap-receipt.${env}.json`, JSON.stringify(receipt, null, 2));

  console.log("Created resources and generated config files:");
  console.log(`- ${workerConfigPath}`);
  console.log(`- ${pagesConfigPath}`);
  console.log(`- .generated/cf-bootstrap-receipt.${env}.json`);

  if (args.deploy) {
    await runCommand("wrangler", ["d1", "migrations", "apply", d1Name, "--config", workerConfigPath]);
    await runCommand("wrangler", ["deploy", "--config", workerConfigPath]);
    await runCommand("pnpm", ["cf:pages:build"]);
    await runCommand("wrangler", ["pages", "deploy", "packages/web/dist/client", "--project-name", "everycal-web", "--config", pagesConfigPath]);
  }

  console.log("\nNext steps:");
  console.log(`1) wrangler secret put ACTIVITYPUB_PRIVATE_KEY_PEM --config ${workerConfigPath} < .generated/activitypub-private-key.${env}.pem`);
  console.log(`2) wrangler secret put JOBS_WEBHOOK_TOKEN --config ${workerConfigPath} < .generated/jobs-webhook-token.${env}.txt`);
  console.log(`3) pnpm cf:check:strict (after copying generated config into tracked wrangler files or using equivalent check script wiring)`);
  console.log(`4) GET ${apiOrigin}/api/v1/system/deploy-readiness should return { ok: true }`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
