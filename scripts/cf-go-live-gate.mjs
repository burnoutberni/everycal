#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

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

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  return { res, payload };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = String(args.env || "prod");
  const apiOrigin = args["api-origin"] ? String(args["api-origin"]) : "";
  if (!apiOrigin) throw new Error("Missing --api-origin for go-live gate checks.");

  const workerConfig = args["worker-config"] ? String(args["worker-config"]) : `.generated/wrangler.${env}.toml`;
  const pagesConfig = args["pages-config"] ? String(args["pages-config"]) : `.generated/packages.web.wrangler.${env}.toml`;
  const receiptPath = args.receipt ? String(args.receipt) : `.generated/cf-bootstrap-receipt.${env}.json`;

  await run("node", [
    "scripts/cf-deploy-readiness.mjs",
    "--worker-config", workerConfig,
    "--pages-config", pagesConfig,
  ]);

  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!receipt.smtp?.configured || !receipt.smtp?.valid) {
    throw new Error("SMTP validation missing or failed in bootstrap receipt.");
  }

  const readiness = await fetchJson(`${apiOrigin}/api/v1/system/deploy-readiness`);
  if (!readiness.res.ok || readiness.payload?.ok !== true) {
    throw new Error(`Runtime readiness failed: ${JSON.stringify(readiness.payload)}`);
  }

  const behavioralFailures = (readiness.payload?.checks || []).filter((check) => check.level === "behavior" && !check.ok);
  if (behavioralFailures.length > 0) {
    throw new Error(`Behavioral readiness checks failed: ${JSON.stringify(behavioralFailures)}`);
  }

  const health = await fetchJson(`${apiOrigin}/healthz`);
  if (!health.res.ok || health.payload?.status !== "ok") {
    throw new Error(`Health endpoint failed: ${JSON.stringify(health.payload)}`);
  }

  const bootstrap = await fetchJson(`${apiOrigin}/api/v1/bootstrap`);
  if (!bootstrap.res.ok || bootstrap.payload?.mode !== "unified") {
    throw new Error(`Bootstrap contract check failed: ${JSON.stringify(bootstrap.payload)}`);
  }

  console.log("\nGo-live gate passed: config + smtp + readiness + smoke checks are green.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
