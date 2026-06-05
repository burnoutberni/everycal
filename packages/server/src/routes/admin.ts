import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { DB } from '../db.js';
import { requireAdminCsrf } from '../middleware/admin-csrf.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizeFederationBlockDomain } from '../lib/federation-blocks.js';
import {
  getEffectiveSetting,
  OPEN_REGISTRATIONS_SETTING_KEY,
  readAdminSetting,
  readEnvOverride,
  readRuntimeSettings,
  runtimeSettingsByKey,
} from '../lib/runtime-settings.js';
import { CURRENT_SCHEMA_VERSION } from '../db/migrations.js';

function readOpenRegistrationsState(db: DB) {
  const dbValue = readAdminSetting<boolean>(db, OPEN_REGISTRATIONS_SETTING_KEY);
  const envRaw = process.env.OPEN_REGISTRATIONS;
  const envOverride = envRaw === 'true' ? true : envRaw === 'false' ? false : null;
  const effective = envOverride !== null ? envOverride : (typeof dbValue === 'boolean' ? dbValue : true);
  return { effective, envOverride, dbValue };
}

function audit(db: DB, adminId: string, action: string, targetType: string, targetId: string, payload: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    nanoid(), adminId, action, targetType, targetId, JSON.stringify(payload)
  );
}

function reconcileLegacyBlockedRemoteEvents(db: DB) {
  db.prepare(`UPDATE remote_events AS re
    SET moderation_state = 'visible'
    WHERE re.moderation_state = 'hidden'
      AND NOT EXISTS (
        SELECT 1
        FROM federation_blocks fb
        WHERE fb.is_active = 1
          AND (
            (fb.block_type = 'actor' AND fb.actor_uri = re.actor_uri)
            OR (
              fb.block_type = 'domain'
              AND fb.domain = (SELECT domain FROM remote_actors WHERE uri = re.actor_uri)
            )
          )
      )`).run();
}

export function adminRoutes(db: DB) {
  const app = new Hono();
  const moderationStates = new Set(['flagged', 'visible', 'hidden']);
  const federationBlockTypes = new Set(['actor', 'domain']);
  app.use('*', requireAdmin());
  app.use('*', requireAdminCsrf());

  app.get('/health', (c) => {
    const accounts = db.prepare('SELECT COUNT(*) as count FROM accounts').get() as {count:number};
    const events = db.prepare('SELECT COUNT(*) as count FROM events').get() as {count:number};
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    const openRegistrations = readOpenRegistrationsState(db);
    return c.json({
      uptimeSec: Math.floor(process.uptime()),
      schemaVersion,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
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
    if (def.kind === 'secret') return c.json({ error: 'secret_setting_persistence_disabled' }, 403);
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
      value: nextValue,
      envLocked: readEnvOverride(def) !== null,
      reason: body.reason.trim(),
    });
    return c.json({ ok: true });
  });

  app.get('/accounts', (c) => {
    const q = (c.req.query('q') || '').trim();
    const enabledAdminCount = (db.prepare('SELECT COUNT(*) as count FROM accounts WHERE is_admin = 1 AND is_disabled = 0').get() as { count: number }).count;
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
    return c.json({ items: rows, enabledAdminCount });
  });

  app.post('/accounts/:id/disable', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const target = db.prepare('SELECT id, is_admin, is_disabled FROM accounts WHERE id = ?').get(id) as { id: string; is_admin: number; is_disabled: number } | undefined;
    if (!target) return c.json({ error: 'account_not_found' }, 404);
    if (target.id === admin.id) return c.json({ error: 'cannot_disable_current_admin' }, 409);
    if (target.is_admin && !target.is_disabled) {
      const enabledAdminCount = (db.prepare('SELECT COUNT(*) as count FROM accounts WHERE is_admin = 1 AND is_disabled = 0').get() as { count: number }).count;
      if (enabledAdminCount <= 1) return c.json({ error: 'cannot_disable_last_enabled_admin' }, 409);
    }
    const result = db.prepare('UPDATE accounts SET is_disabled = 1 WHERE id = ?').run(id);
    if (result.changes === 0) return c.json({ error: 'account_not_found' }, 404);
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
    const result = db.prepare('UPDATE accounts SET is_disabled = 0 WHERE id = ?').run(id);
    if (result.changes === 0) return c.json({ error: 'account_not_found' }, 404);
    audit(db, admin.id, 'account.enable', 'account', id, { reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.post('/events/:id/moderate', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{state:string; reason?:string}>();
    if (!moderationStates.has(body.state)) return c.json({ error: 'invalid_moderation_state' }, 400);
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(id) as { id: string } | undefined;
    if (!event) return c.json({ error: 'event_not_found' }, 404);
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
    const body = await c.req.json<{blockType:string; actorUri?:string; domain?:string; reason?: string}>();
    if (!federationBlockTypes.has(body.blockType)) return c.json({ error: 'invalid_block_type' }, 400);
    const actorUri = body.actorUri?.trim() || null;
    const domain = normalizeFederationBlockDomain(body.domain);
    const targetId = body.blockType === 'actor' ? actorUri : domain;
    if (!targetId) return c.json({ error: 'block_target_required' }, 400);
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const reason = body.reason.trim();
    const id = nanoid();
    db.prepare('INSERT INTO federation_blocks (id, block_type, actor_uri, domain, reason, created_by_account_id, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)').run(
      id,
      body.blockType,
      body.blockType === 'actor' ? targetId : null,
      body.blockType === 'domain' ? targetId : null,
      reason,
      admin.id,
    );
    reconcileLegacyBlockedRemoteEvents(db);
    audit(db, admin.id, 'federation.block', body.blockType, targetId, { reason });
    return c.json({ ok: true, blockId: id });
  });

  app.get('/federation/blocks', (c) => {
    const q = (c.req.query('q') || '').trim();
    const rows = q
      ? db.prepare(`SELECT id, block_type, actor_uri, domain, reason, created_by_account_id, is_active, created_at
          FROM federation_blocks
          WHERE (COALESCE(domain,'') LIKE ? OR COALESCE(actor_uri,'') LIKE ?)
          ORDER BY created_at DESC LIMIT 200`).all(`%${q}%`, `%${q}%`)
      : db.prepare(`SELECT id, block_type, actor_uri, domain, reason, created_by_account_id, is_active, created_at
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
    const block = db.prepare('SELECT id FROM federation_blocks WHERE id = ?').get(id) as { id: string } | undefined;
    if (!block) return c.json({ error: 'federation_block_not_found' }, 404);
    db.prepare('UPDATE federation_blocks SET is_active = 0 WHERE id = ?').run(id);
    reconcileLegacyBlockedRemoteEvents(db);
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
    if (!row) return c.json({ error: 'federation_tombstone_not_found' }, 404);
    db.prepare('DELETE FROM federation_tombstones WHERE id = ?').run(id);
    audit(db, admin.id, 'federation.tombstone.delete', row.object_type, row.object_id, { reason: body.reason.trim() });
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
    const lockout = db.prepare('SELECT username FROM login_attempts WHERE username = ?').get(username) as { username: string } | undefined;
    if (!lockout) return c.json({ error: 'login_lockout_not_found' }, 404);
    db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username);
    audit(db, admin.id, 'security.lockout.reset', 'account_username', username, { reason: body.reason.trim() });
    return c.json({ ok: true });
  });

  app.post('/security/accounts/:id/revoke-auth', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id) as { id: string } | undefined;
    if (!account) return c.json({ error: 'account_not_found' }, 404);
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE account_id = ?').get(id) as { count: number };
    const keyCount = db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE account_id = ?').get(id) as { count: number };
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM api_keys WHERE account_id = ?').run(id);
    audit(db, admin.id, 'security.auth.revoke', 'account', id, { reason: body.reason.trim(), revokedSessions: sessionCount.count, revokedApiKeys: keyCount.count });
    return c.json({ ok: true, revokedSessions: sessionCount.count, revokedApiKeys: keyCount.count });
  });

  app.post('/scrapers/trigger', async (c) => {
    const admin = c.get('user')!;
    if (!getEffectiveSetting<boolean>(db, 'run_jobs_internally', true)) {
      return c.json({ error: 'job_worker_unavailable' }, 503);
    }
    const body = await c.req.json<{scraper?:string; dryRun?:boolean}>();
    const requestedScraper = body.scraper?.trim() || null;
    const scraper = requestedScraper === 'all' ? null : requestedScraper;
    const runId = nanoid();
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at) VALUES (?, 'scraper', 'queued', ?, ?, datetime('now'))")
      .run(runId, JSON.stringify({ scraper, dryRun: !!body.dryRun }), admin.id);
    audit(db, admin.id, 'scraper.trigger', 'scraper', scraper || 'all', { dryRun: !!body.dryRun });
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
