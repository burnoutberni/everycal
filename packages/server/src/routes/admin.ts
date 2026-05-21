import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { DB } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

const OPEN_REGISTRATIONS_SETTING_KEY = 'open_registrations';

type RuntimeSettingDef = {
  key: string;
  label: string;
  description: string;
  kind: 'boolean' | 'string' | 'number' | 'secret';
  envVar?: string;
  defaultValue?: boolean | string | number;
  editable: boolean;
  source: 'db_with_env_override' | 'env_only';
};

const runtimeSettingDefs: RuntimeSettingDef[] = [
  {
    key: OPEN_REGISTRATIONS_SETTING_KEY,
    label: 'Open registrations',
    description: 'Allow new account registration on this instance.',
    kind: 'boolean',
    envVar: 'OPEN_REGISTRATIONS',
    defaultValue: true,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'trusted_proxy',
    label: 'Trusted proxy headers',
    description: 'Trust X-Forwarded-For for rate limit IPs when behind a reverse proxy.',
    kind: 'boolean',
    envVar: 'TRUSTED_PROXY',
    defaultValue: false,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'run_jobs_internally',
    label: 'Run jobs internally',
    description: 'Run scraper/reminder jobs in the same container process.',
    kind: 'boolean',
    envVar: 'RUN_JOBS_INTERNALLY',
    defaultValue: true,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'skip_email_verification',
    label: 'Skip email verification',
    description: 'Bypass email verification (development use only).',
    kind: 'boolean',
    envVar: 'SKIP_EMAIL_VERIFICATION',
    defaultValue: false,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'skip_signature_verify',
    label: 'Skip federation signature verification',
    description: 'Disable ActivityPub signature verification (non-production only).',
    kind: 'boolean',
    envVar: 'SKIP_SIGNATURE_VERIFY',
    defaultValue: false,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'base_url',
    label: 'Base URL',
    description: 'Public base URL used for federation and canonical links.',
    kind: 'string',
    envVar: 'BASE_URL',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'cors_origin',
    label: 'CORS origin allowlist',
    description: 'Comma-separated origins allowed for credentialed requests.',
    kind: 'string',
    envVar: 'CORS_ORIGIN',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'port',
    label: 'Server port',
    description: 'HTTP server port.',
    kind: 'number',
    envVar: 'PORT',
    defaultValue: 3000,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'ssr_anon_cache_ttl_ms',
    label: 'SSR anonymous cache TTL',
    description: 'Anonymous SSR cache time in milliseconds.',
    kind: 'number',
    envVar: 'SSR_ANON_CACHE_TTL_MS',
    defaultValue: 15000,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'database_path',
    label: 'Database path',
    description: 'SQLite database file path.',
    kind: 'string',
    envVar: 'DATABASE_PATH',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'upload_dir',
    label: 'Upload directory',
    description: 'Filesystem path for uploaded files.',
    kind: 'string',
    envVar: 'UPLOAD_DIR',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'og_dir',
    label: 'OG image directory',
    description: 'Filesystem path for generated Open Graph images.',
    kind: 'string',
    envVar: 'OG_DIR',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'federation_queue_health_allowed_accounts',
    label: 'Federation health account allowlist',
    description: 'Account IDs allowed to access federation queue health endpoint.',
    kind: 'string',
    envVar: 'FEDERATION_QUEUE_HEALTH_ALLOWED_ACCOUNTS',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'outbound_retain_delivered_days',
    label: 'Outbound delivered retention (days)',
    description: 'Retention window for delivered outbound queue rows.',
    kind: 'number',
    envVar: 'OUTBOUND_RETAIN_DELIVERED_DAYS',
    defaultValue: 30,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'outbound_retain_failed_days',
    label: 'Outbound failed retention (days)',
    description: 'Retention window for failed outbound queue rows.',
    kind: 'number',
    envVar: 'OUTBOUND_RETAIN_FAILED_DAYS',
    defaultValue: 90,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'outbound_terminal_cleanup_interval_ms',
    label: 'Outbound cleanup interval (ms)',
    description: 'Cleanup interval for terminal outbound queue rows.',
    kind: 'number',
    envVar: 'OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS',
    defaultValue: 3600000,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'inbox_processed_retain_days',
    label: 'Inbox processed retention (days)',
    description: 'Retention window for processed inbox dedupe rows.',
    kind: 'number',
    envVar: 'INBOX_PROCESSED_RETAIN_DAYS',
    defaultValue: 30,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'inbox_failed_retain_days',
    label: 'Inbox failed retention (days)',
    description: 'Retention window for failed inbox dedupe rows.',
    kind: 'number',
    envVar: 'INBOX_FAILED_RETAIN_DAYS',
    defaultValue: 90,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'inbox_processed_max_rows',
    label: 'Inbox dedupe max rows',
    description: 'Maximum retained terminal inbox dedupe rows (0 disables cap).',
    kind: 'number',
    envVar: 'INBOX_PROCESSED_MAX_ROWS',
    defaultValue: 0,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'inbox_processed_cleanup_interval_ms',
    label: 'Inbox cleanup interval (ms)',
    description: 'Cleanup interval for inbox dedupe retention.',
    kind: 'number',
    envVar: 'INBOX_PROCESSED_CLEANUP_INTERVAL_MS',
    defaultValue: 3600000,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'audit_log_retain_days',
    label: 'Audit log retention (days)',
    description: 'Retention window for admin audit log actions (0 keeps indefinitely).',
    kind: 'number',
    envVar: 'AUDIT_LOG_RETAIN_DAYS',
    defaultValue: 365,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'audit_log_cleanup_interval_ms',
    label: 'Audit log cleanup interval (ms)',
    description: 'Cleanup interval for admin audit log database pruning.',
    kind: 'number',
    envVar: 'AUDIT_LOG_CLEANUP_INTERVAL_MS',
    defaultValue: 86400000,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'og_job_concurrency',
    label: 'OG job concurrency',
    description: 'Maximum concurrent OG image jobs.',
    kind: 'number',
    envVar: 'OG_JOB_CONCURRENCY',
    defaultValue: 3,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'smtp_host',
    label: 'SMTP host',
    description: 'Email transport hostname.',
    kind: 'string',
    envVar: 'SMTP_HOST',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'smtp_port',
    label: 'SMTP port',
    description: 'Email transport port.',
    kind: 'number',
    envVar: 'SMTP_PORT',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'smtp_secure',
    label: 'SMTP secure mode',
    description: 'Use secure SMTP transport.',
    kind: 'boolean',
    envVar: 'SMTP_SECURE',
    defaultValue: false,
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'smtp_from',
    label: 'SMTP from address',
    description: 'Default sender address for transactional email.',
    kind: 'string',
    envVar: 'SMTP_FROM',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'smtp_user',
    label: 'SMTP username',
    description: 'Configured SMTP auth username.',
    kind: 'secret',
    envVar: 'SMTP_USER',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'smtp_pass',
    label: 'SMTP password',
    description: 'Configured SMTP auth password.',
    kind: 'secret',
    envVar: 'SMTP_PASS',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'calendar_feed_token_secret',
    label: 'Private feed token secret',
    description: 'Secret used to derive private feed access tokens.',
    kind: 'secret',
    envVar: 'CALENDAR_FEED_TOKEN_SECRET',
    editable: true,
    source: 'db_with_env_override',
  },
  {
    key: 'unsplash_access_key',
    label: 'Unsplash access key',
    description: 'API key for Unsplash image search.',
    kind: 'secret',
    envVar: 'UNSPLASH_ACCESS_KEY',
    editable: true,
    source: 'db_with_env_override',
  },
];

const runtimeSettingsByKey = new Map(runtimeSettingDefs.map((setting) => [setting.key, setting]));

function readAdminSetting<T>(db: DB, key: string): T | null {
  const row = db.prepare('SELECT value_json FROM admin_settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

function readOpenRegistrationsState(db: DB) {
  const dbValue = readAdminSetting<boolean>(db, OPEN_REGISTRATIONS_SETTING_KEY);
  const envRaw = process.env.OPEN_REGISTRATIONS;
  const envOverride = envRaw === 'true' ? true : envRaw === 'false' ? false : null;
  const effective = envOverride !== null ? envOverride : (typeof dbValue === 'boolean' ? dbValue : true);
  return { effective, envOverride, dbValue };
}

function readDbValue(def: RuntimeSettingDef, db: DB): boolean | string | number | null {
  if (def.kind === 'boolean') {
    const raw = readAdminSetting<boolean>(db, def.key);
    return typeof raw === 'boolean' ? raw : null;
  }
  if (def.kind === 'number') {
    const raw = readAdminSetting<number | string>(db, def.key);
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  const raw = readAdminSetting<string>(db, def.key);
  return typeof raw === 'string' ? raw : null;
}

function readEnvOverride(def: RuntimeSettingDef): boolean | string | number | null {
  if (!def.envVar) return null;
  const raw = process.env[def.envVar];
  if (raw == null || raw.trim() === '') return null;
  if (def.kind === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : null;
  if (def.kind === 'number') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (def.kind === 'secret') return '(set)';
  return raw;
}

function readEnvValue(def: RuntimeSettingDef): boolean | string | number | null {
  if (!def.envVar) return null;
  const raw = process.env[def.envVar];
  if (def.kind === 'secret') return raw && raw.trim().length > 0 ? '(set)' : '(not set)';
  if (raw == null || raw.trim() === '') return def.defaultValue ?? null;
  if (def.kind === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : (def.defaultValue ?? null);
  if (def.kind === 'number') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : (def.defaultValue ?? null);
  }
  return raw;
}

function readRuntimeSettings(db: DB) {
  return runtimeSettingDefs.map((def) => {
    const dbValue = def.source === 'db_with_env_override' ? readDbValue(def, db) : null;
    const envOverride = readEnvOverride(def);
    const effectiveValue = def.source === 'db_with_env_override'
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

function audit(db: DB, adminId: string, action: string, targetType: string, targetId: string, payload: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    nanoid(), adminId, action, targetType, targetId, JSON.stringify(payload)
  );
}

export function adminRoutes(db: DB) {
  const app = new Hono();
  app.use('*', requireAdmin());

  app.get('/health', (c) => {
    const accounts = db.prepare('SELECT COUNT(*) as count FROM accounts').get() as {count:number};
    const events = db.prepare('SELECT COUNT(*) as count FROM events').get() as {count:number};
    const openRegistrations = readOpenRegistrationsState(db);
    return c.json({
      uptimeSec: Math.floor(process.uptime()),
      schemaVersion: 12,
      accounts: accounts.count,
      events: events.count,
      openRegistrations: openRegistrations.effective,
      openRegistrationsDb: openRegistrations.dbValue,
      openRegistrationsEnvOverride: openRegistrations.envOverride,
    });
  });

  app.get('/settings', (c) => {
    return c.json({
      items: readRuntimeSettings(db),
    });
  });

  app.post('/settings/:key', async (c) => {
    const admin = c.get('user')!;
    const key = c.req.param('key');
    const def = runtimeSettingsByKey.get(key);
    if (!def) return c.json({ error: 'unknown_setting' }, 404);
    if (!def.editable) return c.json({ error: 'setting_read_only' }, 403);
    const body = await c.req.json<{ value?: unknown; reason?: string }>().catch(() => ({} as { value?: unknown; reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    let nextValue: boolean | string | number;
    if (def.kind === 'boolean') {
      if (typeof body.value !== 'boolean') return c.json({ error: 'invalid_value' }, 400);
      nextValue = body.value;
    } else if (def.kind === 'number') {
      if (typeof body.value !== 'number' || !Number.isFinite(body.value)) return c.json({ error: 'invalid_value' }, 400);
      nextValue = body.value;
    } else if (def.kind === 'string' || def.kind === 'secret') {
      if (typeof body.value !== 'string') return c.json({ error: 'invalid_value' }, 400);
      nextValue = body.value;
    } else {
      return c.json({ error: 'unsupported_setting_type' }, 400);
    }
    db.prepare(`INSERT INTO admin_settings (key, value_json, updated_by_account_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by_account_id=excluded.updated_by_account_id, updated_at=datetime('now')`)
      .run(key, JSON.stringify(nextValue), admin.id);
    audit(db, admin.id, `settings.${key}`, 'admin_setting', key, {
      value: def.kind === 'secret' ? '(updated)' : nextValue,
      envLocked: readEnvOverride(def) !== null,
      reason: body.reason.trim(),
    });
    return c.json({ ok: true });
  });

  app.get('/accounts', (c) => {
    const q = (c.req.query('q') || '').trim();
    const rows = db.prepare(`SELECT a.id, a.username, a.account_type, a.discoverable, a.email_verified, a.created_at, a.is_bot, a.is_disabled, a.is_admin,
        CASE
          WHEN la.locked_until IS NOT NULL AND la.locked_until > datetime('now') THEN 1
          ELSE 0
        END AS is_locked_out
      FROM accounts a
      LEFT JOIN login_attempts la ON la.username = a.username
      WHERE a.username LIKE ?
      ORDER BY a.created_at DESC
      LIMIT 100`).all(`%${q}%`);
    return c.json({ items: rows });
  });

  app.post('/accounts/:id/disable', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    db.prepare('UPDATE accounts SET is_disabled = 1 WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM api_keys WHERE account_id = ?').run(id);
    audit(db, admin.id, 'account.disable', 'account', id, { level: 2, reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.post('/accounts/:id/enable', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    db.prepare('UPDATE accounts SET is_disabled = 0 WHERE id = ?').run(id);
    audit(db, admin.id, 'account.enable', 'account', id, { reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.post('/events/:id/moderate', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{state:string; reason?:string}>();
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    db.prepare('UPDATE events SET moderation_state = ?, moderation_reason = ?, moderated_at = datetime(\'now\') WHERE id = ?').run(body.state, body.reason || null, id);
    audit(db, admin.id, 'event.moderate', 'event', id, { state: body.state, reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.get('/events/moderation-queue', (c) => {
    const state = (c.req.query('state') || 'flagged').trim();
    const selectSql = `SELECT e.id, e.slug, e.title, e.description, e.start_at_utc, e.end_at_utc, e.event_timezone, e.all_day,
        e.location_name, e.location_address, e.url, e.visibility, e.canceled,
        e.moderation_state, e.moderation_reason, e.moderated_at, e.account_id, e.created_by_account_id, e.created_at, e.updated_at,
        owner.username AS owner_username,
        creator.username AS created_by_username,
        GROUP_CONCAT(et.tag, ', ') AS tags
      FROM events e
      LEFT JOIN accounts owner ON owner.id = e.account_id
      LEFT JOIN accounts creator ON creator.id = e.created_by_account_id
      LEFT JOIN event_tags et ON et.event_id = e.id`;
    const rows = state
      ? db.prepare(`${selectSql}
        WHERE e.moderation_state = ?
        GROUP BY e.id
        ORDER BY e.created_at DESC
        LIMIT 200`).all(state)
      : db.prepare(`${selectSql}
        GROUP BY e.id
        ORDER BY e.created_at DESC
        LIMIT 200`).all();
    return c.json({ items: rows });
  });

  app.post('/federation/block', async (c) => {
    const admin = c.get('user')!;
    const body = await c.req.json<{blockType:'actor'|'domain'; actorUri?:string; domain?:string}>();
    if (!body.domain && !body.actorUri) return c.json({ error: 'block_target_required' }, 400);
    const id = nanoid();
    db.prepare('INSERT INTO federation_blocks (id, block_type, actor_uri, domain, created_by_account_id, is_active) VALUES (?, ?, ?, ?, ?, 1)').run(id, body.blockType, body.actorUri || null, body.domain || null, admin.id);
    if (body.blockType === 'domain' && body.domain) {
      db.prepare("UPDATE remote_events SET moderation_state = 'hidden' WHERE actor_uri IN (SELECT uri FROM remote_actors WHERE domain = ?)").run(body.domain);
    }
    if (body.blockType === 'actor' && body.actorUri) {
      db.prepare("UPDATE remote_events SET moderation_state = 'hidden' WHERE actor_uri = ?").run(body.actorUri);
    }
    audit(db, admin.id, 'federation.block', body.blockType, body.actorUri || body.domain || '', {});
    return c.json({ ok: true, blockId: id });
  });

  app.get('/federation/blocks', (c) => {
    const q = (c.req.query('q') || '').trim();
    const rows = q
      ? db.prepare(`SELECT id, block_type, actor_uri, domain, created_by_account_id, is_active, created_at
          FROM federation_blocks
          WHERE (COALESCE(domain,'') LIKE ? OR COALESCE(actor_uri,'') LIKE ?)
          ORDER BY created_at DESC LIMIT 200`).all(`%${q}%`, `%${q}%`)
      : db.prepare(`SELECT id, block_type, actor_uri, domain, created_by_account_id, is_active, created_at
          FROM federation_blocks
          ORDER BY created_at DESC LIMIT 200`).all();
    return c.json({ items: rows });
  });

  app.get('/federation/actors', (c) => {
    const q = (c.req.query('q') || '').trim();
    const status = (c.req.query('status') || '').trim();
    const domain = (c.req.query('domain') || '').trim();
    const rows = db.prepare(`SELECT uri, preferred_username, domain, fetch_status, last_fetched_at, next_retry_at, last_error, gone_at, created_at
      FROM remote_actors
      WHERE (? = '' OR domain = ?)
        AND (? = '' OR COALESCE(fetch_status, 'active') = ?)
        AND (? = '' OR uri LIKE ? OR preferred_username LIKE ? OR domain LIKE ?)
      ORDER BY COALESCE(next_retry_at, last_fetched_at) DESC
      LIMIT 200`).all(domain, domain, status, status, q, `%${q}%`, `%${q}%`, `%${q}%`);
    return c.json({ items: rows });
  });

  app.get('/federation/domains', (c) => {
    const rows = db.prepare(`SELECT domain,
      COUNT(*) AS actor_count,
      SUM(CASE WHEN fetch_status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN fetch_status = 'gone' THEN 1 ELSE 0 END) AS gone_count,
      MAX(last_fetched_at) AS last_fetched_at
      FROM remote_actors
      GROUP BY domain
      ORDER BY actor_count DESC, domain ASC
      LIMIT 200`).all();
    return c.json({ items: rows });
  });

  app.post('/federation/blocks/:id/unblock', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    db.prepare('UPDATE federation_blocks SET is_active = 0 WHERE id = ?').run(id);
    audit(db, admin.id, 'federation.unblock', 'federation_block', id, { reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.get('/federation/tombstones', (c) => {
    const q = (c.req.query('q') || '').trim();
    const rows = q
      ? db.prepare(`SELECT id, object_type, object_id, reason, created_at, expires_at
          FROM federation_tombstones
          WHERE object_id LIKE ? OR object_type LIKE ?
          ORDER BY created_at DESC
          LIMIT 200`).all(`%${q}%`, `%${q}%`)
      : db.prepare(`SELECT id, object_type, object_id, reason, created_at, expires_at
          FROM federation_tombstones
          ORDER BY created_at DESC
          LIMIT 200`).all();
    return c.json({ items: rows });
  });

  app.post('/federation/tombstones', async (c) => {
    const admin = c.get('user')!;
    const body = await c.req.json<{ objectType?: string; objectId?: string; reason?: string; expiresAt?: string }>().catch(() => ({} as { objectType?: string; objectId?: string; reason?: string; expiresAt?: string }));
    if (!body.objectType?.trim() || !body.objectId?.trim()) return c.json({ error: 'object_required' }, 400);
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const id = nanoid();
    db.prepare('INSERT INTO federation_tombstones (id, object_type, object_id, reason, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      body.objectType.trim(),
      body.objectId.trim(),
      body.reason.trim(),
      body.expiresAt?.trim() || null,
    );
    audit(db, admin.id, 'federation.tombstone.create', body.objectType.trim(), body.objectId.trim(), { reason: body.reason.trim() });
    return c.json({ ok: true, id });
  });

  app.post('/federation/tombstones/:id/delete', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const row = db.prepare('SELECT object_type, object_id FROM federation_tombstones WHERE id = ?').get(id) as { object_type: string; object_id: string } | undefined;
    db.prepare('DELETE FROM federation_tombstones WHERE id = ?').run(id);
    audit(db, admin.id, 'federation.tombstone.delete', row?.object_type || 'federation_tombstone', row?.object_id || id, { reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.get('/security/login-lockouts', (c) => {
    const q = (c.req.query('q') || '').trim();
    const rows = q
      ? db.prepare(`SELECT username, attempts, locked_until, last_attempt
          FROM login_attempts
          WHERE username LIKE ?
          ORDER BY COALESCE(locked_until, last_attempt) DESC
          LIMIT 200`).all(`%${q}%`)
      : db.prepare(`SELECT username, attempts, locked_until, last_attempt
          FROM login_attempts
          ORDER BY COALESCE(locked_until, last_attempt) DESC
          LIMIT 200`).all();
    return c.json({ items: rows });
  });

  app.post('/security/login-lockouts/:username/reset', async (c) => {
    const admin = c.get('user')!;
    const username = c.req.param('username');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username);
    audit(db, admin.id, 'security.lockout.reset', 'account_username', username, { reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.post('/security/accounts/:id/revoke-auth', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE account_id = ?').get(id) as { count: number };
    const keyCount = db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE account_id = ?').get(id) as { count: number };
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM api_keys WHERE account_id = ?').run(id);
    audit(db, admin.id, 'security.auth.revoke', 'account', id, { reason: body.reason.trim(), revokedSessions: sessionCount.count, revokedApiKeys: keyCount.count });
    return c.json({ ok: true, revokedSessions: sessionCount.count, revokedApiKeys: keyCount.count });
  });

  app.post('/scrapers/trigger', async (c) => {
    const admin = c.get('user')!;
    const body = await c.req.json<{scraper?:string; dryRun?:boolean}>();
    const runId = nanoid();
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at) VALUES (?, 'scraper', 'queued', ?, ?, datetime('now'))")
      .run(runId, JSON.stringify({ scraper: body.scraper || null, dryRun: !!body.dryRun }), admin.id);
    audit(db, admin.id, 'scraper.trigger', 'scraper', body.scraper || 'all', { dryRun: !!body.dryRun });
    return c.json({ ok: true, runId, status: 'queued' });
  });

  app.get('/audit-log', (c) => {
    const action = (c.req.query('action') || '').trim();
    const actor = (c.req.query('actor') || '').trim();
    const target = (c.req.query('target') || '').trim();
    const rows = db.prepare(`SELECT id, admin_account_id, action_type, target_type, target_id, payload_json, created_at
      FROM admin_audit_log
      WHERE (? = '' OR action_type = ?)
        AND (? = '' OR admin_account_id = ?)
        AND (? = '' OR target_id = ?)
      ORDER BY created_at DESC LIMIT 500`).all(action, action, actor, actor, target, target);
    return c.json({ items: rows });
  });

  app.get('/jobs/runs', (c) => {
    const rows = db.prepare(`SELECT id, job_type, status, payload_json, result_json, created_by_account_id, created_at, started_at, finished_at
      FROM admin_job_runs
      ORDER BY created_at DESC LIMIT 200`).all();
    return c.json({ items: rows });
  });

  return app;
}

export function getEffectiveSetting<T>(db: DB, key: string, defaultValue: T): T {
  const def = runtimeSettingDefs.find((d) => d.key === key);
  if (!def) return defaultValue;
  const dbValue = def.source === 'db_with_env_override' ? readDbValue(def, db) : null;
  const envOverride = readEnvOverride(def);
  const effectiveValue = def.source === 'db_with_env_override'
    ? (envOverride !== null ? envOverride : (dbValue ?? def.defaultValue ?? null))
    : readEnvValue(def);
  return (effectiveValue !== null ? effectiveValue : defaultValue) as T;
}

export function cleanupAdminAuditLogs(
  db: DB,
  options: { retainDays?: number } = {}
): { deletedCount: number } {
  const retainDays = Math.max(0, Math.floor(options.retainDays ?? 365));
  if (retainDays === 0) {
    return { deletedCount: 0 };
  }
  const cleanup = db.transaction((days: number) => {
    const result = db
      .prepare("DELETE FROM admin_audit_log WHERE created_at < datetime('now', '-' || ? || ' days')")
      .run(days);
    return { deletedCount: result.changes };
  });
  return cleanup(retainDays);
}

export function startAdminAuditLogCleanupWorker(db: DB): NodeJS.Timeout | null {
  const intervalMs = Math.max(60000, getEffectiveSetting<number>(db, 'audit_log_cleanup_interval_ms', 86400000));

  const run = () => {
    try {
      const actualRetainDays = getEffectiveSetting<number>(db, 'audit_log_retain_days', 365);
      const result = cleanupAdminAuditLogs(db, { retainDays: actualRetainDays });
      if (result.deletedCount > 0) {
        console.log(`[Admin] cleaned admin audit log rows: deleted=${result.deletedCount}`);
      }
    } catch (err) {
      console.error("[Admin] admin audit log cleanup failed", err);
    }
  };

  run();
  return setInterval(run, intervalMs);
}
