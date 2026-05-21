import type { DB } from "../db.js";

export const OPEN_REGISTRATIONS_SETTING_KEY = "open_registrations";

export type RuntimeSettingDef = {
  key: string;
  label: string;
  description: string;
  kind: "boolean" | "string" | "number" | "secret";
  envVar?: string;
  defaultValue?: boolean | string | number;
  editable: boolean;
  source: "db_with_env_override" | "env_only";
};

export const runtimeSettingDefs: RuntimeSettingDef[] = [
  { key: OPEN_REGISTRATIONS_SETTING_KEY, label: "Open registrations", description: "Allow new account registration on this instance.", kind: "boolean", envVar: "OPEN_REGISTRATIONS", defaultValue: true, editable: true, source: "db_with_env_override" },
  { key: "trusted_proxy", label: "Trusted proxy headers", description: "Trust X-Forwarded-For for rate limit IPs when behind a reverse proxy.", kind: "boolean", envVar: "TRUSTED_PROXY", defaultValue: false, editable: true, source: "db_with_env_override" },
  { key: "run_jobs_internally", label: "Run jobs internally", description: "Run scraper/reminder jobs in the same container process.", kind: "boolean", envVar: "RUN_JOBS_INTERNALLY", defaultValue: true, editable: false, source: "env_only" },
  { key: "skip_email_verification", label: "Skip email verification", description: "Bypass email verification (development use only).", kind: "boolean", envVar: "SKIP_EMAIL_VERIFICATION", defaultValue: false, editable: false, source: "env_only" },
  { key: "skip_signature_verify", label: "Skip federation signature verification", description: "Disable ActivityPub signature verification (non-production only).", kind: "boolean", envVar: "SKIP_SIGNATURE_VERIFY", defaultValue: false, editable: true, source: "db_with_env_override" },
  { key: "base_url", label: "Base URL", description: "Public base URL used for federation and canonical links.", kind: "string", envVar: "BASE_URL", editable: false, source: "env_only" },
  { key: "cors_origin", label: "CORS origin allowlist", description: "Comma-separated origins allowed for credentialed requests.", kind: "string", envVar: "CORS_ORIGIN", editable: true, source: "db_with_env_override" },
  { key: "port", label: "Server port", description: "HTTP server port.", kind: "number", envVar: "PORT", defaultValue: 3000, editable: false, source: "env_only" },
  { key: "ssr_anon_cache_ttl_ms", label: "SSR anonymous cache TTL", description: "Anonymous SSR cache time in milliseconds.", kind: "number", envVar: "SSR_ANON_CACHE_TTL_MS", defaultValue: 15000, editable: true, source: "db_with_env_override" },
  { key: "database_path", label: "Database path", description: "SQLite database file path.", kind: "string", envVar: "DATABASE_PATH", editable: false, source: "env_only" },
  { key: "upload_dir", label: "Upload directory", description: "Filesystem path for uploaded files.", kind: "string", envVar: "UPLOAD_DIR", editable: false, source: "env_only" },
  { key: "og_dir", label: "OG image directory", description: "Filesystem path for generated Open Graph images.", kind: "string", envVar: "OG_DIR", editable: false, source: "env_only" },
  { key: "federation_queue_health_allowed_accounts", label: "Federation health account allowlist", description: "Account IDs allowed to access federation queue health endpoint.", kind: "string", envVar: "FEDERATION_QUEUE_HEALTH_ALLOWED_ACCOUNTS", editable: true, source: "db_with_env_override" },
  { key: "outbound_retain_delivered_days", label: "Outbound delivered retention (days)", description: "Retention window for delivered outbound queue rows.", kind: "number", envVar: "OUTBOUND_RETAIN_DELIVERED_DAYS", defaultValue: 30, editable: true, source: "db_with_env_override" },
  { key: "outbound_retain_failed_days", label: "Outbound failed retention (days)", description: "Retention window for failed outbound queue rows.", kind: "number", envVar: "OUTBOUND_RETAIN_FAILED_DAYS", defaultValue: 90, editable: true, source: "db_with_env_override" },
  { key: "outbound_terminal_cleanup_interval_ms", label: "Outbound cleanup interval (ms)", description: "Cleanup interval for terminal outbound queue rows.", kind: "number", envVar: "OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS", defaultValue: 3600000, editable: true, source: "db_with_env_override" },
  { key: "inbox_processed_retain_days", label: "Inbox processed retention (days)", description: "Retention window for processed inbox dedupe rows.", kind: "number", envVar: "INBOX_PROCESSED_RETAIN_DAYS", defaultValue: 30, editable: true, source: "db_with_env_override" },
  { key: "inbox_failed_retain_days", label: "Inbox failed retention (days)", description: "Retention window for failed inbox dedupe rows.", kind: "number", envVar: "INBOX_FAILED_RETAIN_DAYS", defaultValue: 90, editable: true, source: "db_with_env_override" },
  { key: "inbox_processed_max_rows", label: "Inbox dedupe max rows", description: "Maximum retained terminal inbox dedupe rows (0 disables cap).", kind: "number", envVar: "INBOX_PROCESSED_MAX_ROWS", defaultValue: 0, editable: true, source: "db_with_env_override" },
  { key: "inbox_processed_cleanup_interval_ms", label: "Inbox cleanup interval (ms)", description: "Cleanup interval for inbox dedupe retention.", kind: "number", envVar: "INBOX_PROCESSED_CLEANUP_INTERVAL_MS", defaultValue: 3600000, editable: true, source: "db_with_env_override" },
  { key: "audit_log_retain_days", label: "Audit log retention (days)", description: "Retention window for admin audit log actions (0 keeps indefinitely).", kind: "number", envVar: "AUDIT_LOG_RETAIN_DAYS", defaultValue: 365, editable: true, source: "db_with_env_override" },
  { key: "audit_log_cleanup_interval_ms", label: "Audit log cleanup interval (ms)", description: "Cleanup interval for admin audit log database pruning.", kind: "number", envVar: "AUDIT_LOG_CLEANUP_INTERVAL_MS", defaultValue: 86400000, editable: true, source: "db_with_env_override" },
  { key: "og_job_concurrency", label: "OG job concurrency", description: "Maximum concurrent OG image jobs.", kind: "number", envVar: "OG_JOB_CONCURRENCY", defaultValue: 3, editable: false, source: "env_only" },
  { key: "smtp_host", label: "SMTP host", description: "Email transport hostname.", kind: "string", envVar: "SMTP_HOST", editable: false, source: "env_only" },
  { key: "smtp_port", label: "SMTP port", description: "Email transport port.", kind: "number", envVar: "SMTP_PORT", editable: false, source: "env_only" },
  { key: "smtp_secure", label: "SMTP secure mode", description: "Use secure SMTP transport.", kind: "boolean", envVar: "SMTP_SECURE", defaultValue: false, editable: false, source: "env_only" },
  { key: "smtp_from", label: "SMTP from address", description: "Default sender address for transactional email.", kind: "string", envVar: "SMTP_FROM", editable: false, source: "env_only" },
  { key: "smtp_user", label: "SMTP username", description: "Configured SMTP auth username.", kind: "secret", envVar: "SMTP_USER", editable: false, source: "env_only" },
  { key: "smtp_pass", label: "SMTP password", description: "Configured SMTP auth password.", kind: "secret", envVar: "SMTP_PASS", editable: false, source: "env_only" },
  { key: "calendar_feed_token_secret", label: "Private feed token secret", description: "Secret used to derive private feed access tokens.", kind: "secret", envVar: "CALENDAR_FEED_TOKEN_SECRET", editable: false, source: "env_only" },
  { key: "unsplash_access_key", label: "Unsplash access key", description: "API key for Unsplash image search.", kind: "secret", envVar: "UNSPLASH_ACCESS_KEY", editable: false, source: "env_only" },
];

export const runtimeSettingsByKey = new Map(runtimeSettingDefs.map((setting) => [setting.key, setting]));

export function readAdminSetting<T>(db: DB, key: string): T | null {
  const row = db.prepare("SELECT value_json FROM admin_settings WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function readDbValue(def: RuntimeSettingDef, db: DB): boolean | string | number | null {
  if (def.kind === "boolean") {
    const raw = readAdminSetting<boolean>(db, def.key);
    return typeof raw === "boolean" ? raw : null;
  }
  if (def.kind === "number") {
    const raw = readAdminSetting<number | string>(db, def.key);
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  const raw = readAdminSetting<string>(db, def.key);
  return typeof raw === "string" ? raw : null;
}

export function readEnvOverride(def: RuntimeSettingDef): boolean | string | number | null {
  if (!def.envVar) return null;
  const raw = process.env[def.envVar];
  if (raw == null || raw.trim() === "") return null;
  if (def.kind === "boolean") return raw === "true" ? true : raw === "false" ? false : null;
  if (def.kind === "number") {
    if (!/^-?\d+$/.test(raw.trim())) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (def.kind === "secret") return "(set)";
  return raw;
}

export function readEnvValue(def: RuntimeSettingDef): boolean | string | number | null {
  if (!def.envVar) return null;
  const raw = process.env[def.envVar];
  if (def.kind === "secret") return raw && raw.trim().length > 0 ? "(set)" : "(not set)";
  if (raw == null || raw.trim() === "") return def.defaultValue ?? null;
  if (def.kind === "boolean") return raw === "true" ? true : raw === "false" ? false : (def.defaultValue ?? null);
  if (def.kind === "number") {
    if (!/^-?\d+$/.test(raw.trim())) return def.defaultValue ?? null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : (def.defaultValue ?? null);
  }
  return raw;
}

export function getEffectiveSetting<T>(db: DB, key: string, defaultValue: T): T {
  const def = runtimeSettingDefs.find((d) => d.key === key);
  if (!def) return defaultValue;
  const dbValue = def.source === "db_with_env_override" ? readDbValue(def, db) : null;
  const envOverride = readEnvOverride(def);
  const effectiveValue = def.source === "db_with_env_override"
    ? (envOverride !== null ? envOverride : (dbValue ?? def.defaultValue ?? null))
    : readEnvValue(def);
  return (effectiveValue !== null ? effectiveValue : defaultValue) as T;
}

export function readRuntimeSettings(db: DB) {
  return runtimeSettingDefs.map((def) => {
    const dbValue = def.source === "db_with_env_override" ? readDbValue(def, db) : null;
    const envOverride = readEnvOverride(def);
    const effectiveValue = def.source === "db_with_env_override"
      ? (envOverride !== null ? envOverride : (dbValue ?? def.defaultValue ?? null))
      : readEnvValue(def);
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      kind: def.kind,
      value: dbValue,
      effectiveValue,
      envOverride,
      lockedByEnv: envOverride !== null,
      editable: def.editable,
    };
  });
}
