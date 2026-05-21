import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase } from '../src/db.js';
import { adminRoutes } from '../src/routes/admin.js';

describe('admin routes', () => {
  it('enforces requireAdmin and writes audit log', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1),('u1','user',0)").run();
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone) VALUES ('e1','u1','T','2026-01-01','2026-01-01 10:00:00','UTC')").run();

    const mount = (user: any) => {
      const app = new Hono();
      app.use('*', async (c, next) => { c.set('user', user); await next(); });
      app.route('/api/v1/admin', adminRoutes(db));
      return app;
    };

    const forbidden = await mount({ id:'u1', username:'user', displayName:null, isAdmin:false }).request('/api/v1/admin/accounts');
    expect(forbidden.status).toBe(403);

    const ok = await mount({ id:'a1', username:'admin', displayName:null, isAdmin:true }).request('/api/v1/admin/events/e1/moderate', {
      method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ state: 'hidden', reason: 'spam' })
    });
    expect(ok.status).toBe(200);

    const row = db.prepare("SELECT action_type FROM admin_audit_log WHERE target_id = 'e1'").get() as {action_type:string}|undefined;
    expect(row?.action_type).toBe('event.moderate');
  });

  it('supports admin settings and security mutations with audit', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1),('u1','user',0)").run();
    db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES ('s1','u1','2099-01-01 00:00:00')").run();
    db.prepare("INSERT INTO api_keys (id, account_id, key_hash, label) VALUES ('k1','u1','h','l')").run();
    db.prepare("INSERT INTO login_attempts (username, attempts, locked_until, last_attempt) VALUES ('user',5,'2099-01-01T00:00:00.000Z',datetime('now'))").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const settingRes = await app.request('/api/v1/admin/settings/open_registrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: false, reason: 'maintenance window' }),
    });
    expect(settingRes.status).toBe(200);

    const revokeRes = await app.request('/api/v1/admin/security/accounts/u1/revoke-auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'incident response' }),
    });
    expect(revokeRes.status).toBe(200);

    const lockoutResetRes = await app.request('/api/v1/admin/security/login-lockouts/user/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'verified owner' }),
    });
    expect(lockoutResetRes.status).toBe(200);

    const sessionsLeft = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE account_id = 'u1'").get() as { count: number };
    const keysLeft = db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE account_id = 'u1'").get() as { count: number };
    const lockoutLeft = db.prepare("SELECT COUNT(*) as count FROM login_attempts WHERE username = 'user'").get() as { count: number };
    expect(sessionsLeft.count).toBe(0);
    expect(keysLeft.count).toBe(0);
    expect(lockoutLeft.count).toBe(0);
  });
});
