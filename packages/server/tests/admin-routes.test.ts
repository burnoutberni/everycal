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
});
