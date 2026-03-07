#!/usr/bin/env node

import { mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

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

async function putWranglerSecret(name, value, workerConfigPath) {
  await runCommand("wrangler", ["secret", "put", name, "--config", workerConfigPath], { stdinText: `${value}\n` });
}

function renderCompanionWorkerSource(jobType) {
  return `export default {
  async fetch(request) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const payload = await request.text();
    console.log("[${jobType}] received job payload", payload.slice(0, 1000));
    return new Response(JSON.stringify({ ok: true, worker: "${jobType}" }), {
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

async function deployCompanionWorker(name, scriptPath) {
  await runCommand("wrangler", [
    "deploy",
    scriptPath,
    "--name",
    name,
    "--compatibility-date",
    COMPATIBILITY_DATE,
  ]);
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

  const d1Name = `${projectSlug}-${env}`;
  const kvTitle = `${projectSlug}-${env}-rate-limits`;
  const r2Bucket = `${projectSlug}-${env}-uploads`;
  const queueName = `${projectSlug}-${env}-jobs`;
  const remindersService = `${projectSlug}-reminders-${env}`;
  const scrapersService = `${projectSlug}-scrapers-${env}`;

  const summary = {
    mode: dryRun ? "plan" : "apply",
    input: { domain, apiHost, env, projectSlug, pagesProject },
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
    },
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
      queue: { name: queueName },
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
  }

  if (shouldDeploy) {
    if (shouldProvisionCompanionWorkers) {
      console.log("\nDeploying companion service workers (reminders/scrapers)...");
      await deployCompanionWorker(remindersService, remindersCompanionPath);
      await deployCompanionWorker(scrapersService, scrapersCompanionPath);
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
      console.log(`  wrangler deploy ${remindersCompanionPath} --name ${remindersService} --compatibility-date ${COMPATIBILITY_DATE}`);
      console.log(`  wrangler deploy ${scrapersCompanionPath} --name ${scrapersService} --compatibility-date ${COMPATIBILITY_DATE}`);
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
