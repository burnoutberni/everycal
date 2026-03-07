#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function getTomlValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

function hasBinding(text, bindingName) {
  return new RegExp(`binding\\s*=\\s*"${bindingName}"`, "m").test(text);
}

function isPlaceholderLike(value) {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes("replace_with")
    || normalized.includes("example.com")
    || normalized.includes("example.workers.dev")
    || normalized.includes("example.pages.dev");
}

async function main() {
  const workerToml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  const pagesToml = await readFile(new URL("../packages/web/wrangler.toml", import.meta.url), "utf8");

  const checks = [
    {
      id: "worker.database_id",
      ok: !isPlaceholderLike(getTomlValue(workerToml, "database_id")),
      detail: "wrangler.toml should use a real D1 database_id.",
    },
    {
      id: "worker.rate_limits_kv_id",
      ok: !isPlaceholderLike(getTomlValue(workerToml, "id")),
      detail: "wrangler.toml should use a real KV namespace id for RATE_LIMITS_KV (or remove that binding).",
    },
    {
      id: "worker.base_url",
      ok: !isPlaceholderLike(getTomlValue(workerToml, "BASE_URL")),
      detail: "wrangler.toml BASE_URL should point at your deployed API/Worker URL.",
    },
    {
      id: "worker.cors_origin",
      ok: !isPlaceholderLike(getTomlValue(workerToml, "CORS_ORIGIN")),
      detail: "wrangler.toml CORS_ORIGIN should point at your deployed web origin.",
    },
    {
      id: "pages.api_origin",
      ok: !isPlaceholderLike(getTomlValue(pagesToml, "API_ORIGIN")),
      detail: "packages/web/wrangler.toml API_ORIGIN should point at your deployed Worker API origin.",
    },
    {
      id: "pages.vite_api_origin",
      ok: !isPlaceholderLike(getTomlValue(pagesToml, "VITE_API_ORIGIN")),
      detail: "packages/web/wrangler.toml VITE_API_ORIGIN should point at your deployed Worker API origin.",
    },
    {
      id: "worker.jobs_queue_binding",
      ok: hasBinding(workerToml, "JOBS_QUEUE"),
      detail: "wrangler.toml should define JOBS_QUEUE producer binding.",
    },
    {
      id: "worker.reminders_executor_binding",
      ok: hasBinding(workerToml, "REMINDERS_SERVICE"),
      detail: "wrangler.toml should define REMINDERS_SERVICE or you must provide REMINDERS_WEBHOOK_URL secret at runtime.",
    },
    {
      id: "worker.scrapers_executor_binding",
      ok: hasBinding(workerToml, "SCRAPERS_SERVICE"),
      detail: "wrangler.toml should define SCRAPERS_SERVICE or you must provide SCRAPERS_WEBHOOK_URL secret at runtime.",
    },
  ];

  const failing = checks.filter((check) => !check.ok);
  const warnOnly = process.argv.includes("--warn");

  console.log("Cloudflare deploy readiness checks");
  for (const check of checks) {
    const marker = check.ok ? "✓" : warnOnly ? "!" : "✗";
    console.log(`${marker} ${check.id} - ${check.detail}`);
  }

  if (failing.length > 0 && !warnOnly) {
    console.error(`\nFailed ${failing.length}/${checks.length} checks.`);
    process.exit(1);
  }

  if (failing.length > 0) {
    console.warn(`\nWarning: ${failing.length}/${checks.length} checks need real deployment values.`);
    return;
  }

  console.log(`\nAll ${checks.length} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
