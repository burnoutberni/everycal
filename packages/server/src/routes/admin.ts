import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { DB } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

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
    return c.json({ uptimeSec: Math.floor(process.uptime()), schemaVersion: 12, accounts: accounts.count, events: events.count, openRegistrationsEnv: process.env.REGISTRATION_MODE !== 'closed' });
  });

  app.get('/accounts', (c) => {
    const q = (c.req.query('q') || '').trim();
    const rows = db.prepare(`SELECT id, username, account_type, discoverable, email_verified, created_at, is_bot, is_disabled, is_admin FROM accounts WHERE username LIKE ? ORDER BY created_at DESC LIMIT 100`).all(`%${q}%`);
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
    const rows = db.prepare(`SELECT id, title, start_at_utc, end_at_utc, moderation_state, moderation_reason, moderated_at, account_id, created_by_account_id, created_at
      FROM events
      WHERE moderation_state = ?
      ORDER BY created_at DESC
      LIMIT 200`).all(state);
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

  app.post('/federation/blocks/:id/unblock', async (c) => {
    const admin = c.get('user')!;
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    if (!body.reason || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    db.prepare('UPDATE federation_blocks SET is_active = 0 WHERE id = ?').run(id);
    audit(db, admin.id, 'federation.unblock', 'federation_block', id, { reason: body.reason.trim() });
    return c.json({ ok: true });
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
