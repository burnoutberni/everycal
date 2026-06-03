import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase } from '../src/db.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';
import { adminRoutes, cleanupAdminAuditLogs } from '../src/routes/admin.js';
import { getEffectiveSetting, runtimeSettingsByKey, runtimeSettingDefs } from '../src/lib/runtime-settings.js';
import { t } from '../src/lib/i18n.js';

describe('admin routes', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBaseUrl = process.env.BASE_URL;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.BASE_URL = 'http://localhost:3000';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.BASE_URL = originalBaseUrl;
  });

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

    const forbidden = await mount({ id:'u1', username:'user', displayName:null, isAdmin:false }).request('/api/v1/admin/accounts', {
      headers: { 'accept-language': 'de' },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: t('de', 'common.forbidden') });

    const ok = await mount({ id:'a1', username:'admin', displayName:null, isAdmin:true }).request('/api/v1/admin/events/e1/moderate', {
      method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ state: 'hidden', reason: 'spam' })
    });
    expect(ok.status).toBe(200);

    const row = db.prepare("SELECT action_type FROM admin_audit_log WHERE target_id = 'e1'").get() as {action_type:string}|undefined;
    expect(row?.action_type).toBe('event.moderate');
  });

  it('enforces CSRF token checks for cookie-auth admin mutations', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const missingToken = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        cookie: 'everycal_session=s1; everycal_csrf=csrf1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockType: 'domain', domain: 'bad.test' }),
    });
    expect(missingToken.status).toBe(403);
    expect(await missingToken.json()).toEqual({ error: 'csrf_token_invalid' });

    const badOrigin = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: {
        origin: 'http://evil.example',
        cookie: 'everycal_session=s1; everycal_csrf=csrf1',
        'x-csrf-token': 'csrf1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockType: 'domain', domain: 'bad.test' }),
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toEqual({ error: 'csrf_origin_mismatch' });

    const ok = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        cookie: 'everycal_session=s1; everycal_csrf=csrf1',
        'x-csrf-token': 'csrf1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockType: 'domain', domain: 'bad.test', reason: 'malicious federation source' }),
    });
    expect(ok.status).toBe(200);

    const okWithoutOriginHeaders = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: {
        cookie: 'everycal_session=s1; everycal_csrf=csrf1',
        'x-csrf-token': 'csrf1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockType: 'domain', domain: 'headless-client.test', reason: 'non-browser client request' }),
    });
    expect(okWithoutOriginHeaders.status).toBe(200);
  });

  it('allows CSRF-protected admin mutations from the Vite dev origin in development', async () => {
    process.env.NODE_ENV = 'development';

    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        cookie: 'everycal_session=s1; everycal_csrf=csrf1',
        'x-csrf-token': 'csrf1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockType: 'domain', domain: 'vite-dev-ui.test', reason: 'dev verification' }),
    });

    expect(res.status).toBe(200);
  });

  it('allows API key admin mutations without CSRF token', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: {
        authorization: 'ApiKey test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockType: 'domain', domain: 'api-key-only.test', reason: 'policy enforcement' }),
    });

    expect(res.status).toBe(200);
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

  it('returns 404 for missing targets on admin mutation endpoints', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const disableRes = await app.request('/api/v1/admin/accounts/missing/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'incident response' }),
    });
    expect(disableRes.status).toBe(404);
    expect(await disableRes.json()).toEqual({ error: 'account_not_found' });

    const enableRes = await app.request('/api/v1/admin/accounts/missing/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'incident response' }),
    });
    expect(enableRes.status).toBe(404);
    expect(await enableRes.json()).toEqual({ error: 'account_not_found' });

    const moderateRes = await app.request('/api/v1/admin/events/missing/moderate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'hidden', reason: 'policy' }),
    });
    expect(moderateRes.status).toBe(404);
    expect(await moderateRes.json()).toEqual({ error: 'event_not_found' });

    const unblockRes = await app.request('/api/v1/admin/federation/blocks/missing/unblock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'policy updated' }),
    });
    expect(unblockRes.status).toBe(404);
    expect(await unblockRes.json()).toEqual({ error: 'federation_block_not_found' });

    const lockoutResetRes = await app.request('/api/v1/admin/security/login-lockouts/missing/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'verified owner' }),
    });
    expect(lockoutResetRes.status).toBe(404);
    expect(await lockoutResetRes.json()).toEqual({ error: 'login_lockout_not_found' });

    const revokeRes = await app.request('/api/v1/admin/security/accounts/missing/revoke-auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'incident response' }),
    });
    expect(revokeRes.status).toBe(404);
    expect(await revokeRes.json()).toEqual({ error: 'account_not_found' });

    const auditRow = db.prepare("SELECT COUNT(*) as count FROM admin_audit_log WHERE target_id = 'missing'").get() as { count: number };
    expect(auditRow.count).toBe(0);
  });

  it('lists only flagged moderation requests by default', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1),('u1','user',0)").run();
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, moderation_state) VALUES ('e1','u1','Flagged','2026-01-01','2026-01-01 10:00:00','UTC','flagged')").run();
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, moderation_state) VALUES ('e2','u1','Visible','2026-01-01','2026-01-01 10:00:00','UTC','visible')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/events/moderation-queue');
    const body = await res.json() as { items: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual(['e1']);
  });

  it('GET /health returns statistics, actual schema version, and expected schema version', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone) VALUES ('e1','a1','T','2026-01-01','2026-01-01 10:00:00','UTC')").run();
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/health');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.schemaVersion).toBe(CURRENT_SCHEMA_VERSION - 1);
    expect(body.expectedSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(body.accounts).toBe(1);
    expect(body.events).toBe(1);
    expect(body.openRegistrations).toBe(true);
  });

  it('GET /settings returns all runtime settings', async () => {
    const db = initDatabase(':memory:');
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/settings');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items.length).toBeGreaterThan(0);
    const openRegsSetting = body.items.find((item: any) => item.key === 'open_registrations');
    expect(openRegsSetting).toBeDefined();
    expect(openRegsSetting.effectiveValue).toBe(true);
    expect(openRegsSetting.applyScope).toBe('immediate');
    const portSetting = body.items.find((item: any) => item.key === 'port');
    expect(portSetting.applyScope).toBe('restart_required');
  });

  it('POST /settings/:key validates key, reason, values, and logs secrets safely', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // 1. Unknown setting key
    const res1 = await app.request('/api/v1/admin/settings/non_existent_setting_key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true, reason: 'test' }),
    });
    expect(res1.status).toBe(404);
    expect(await res1.json()).toEqual({ error: 'unknown_setting' });

    // 2. Missing reason
    const res2 = await app.request('/api/v1/admin/settings/open_registrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: false }),
    });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: 'reason_required' });

    // 3. Invalid boolean value (e.g. passing a number for boolean)
    const res3 = await app.request('/api/v1/admin/settings/open_registrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 123, reason: 'invalid val' }),
    });
    expect(res3.status).toBe(400);
    expect(await res3.json()).toEqual({ error: 'invalid_value' });

    // 4. Invalid number value (e.g. passing a boolean for number)
    const res4 = await app.request('/api/v1/admin/settings/audit_log_cleanup_interval_ms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true, reason: 'invalid val' }),
    });
    expect(res4.status).toBe(400);
    expect(await res4.json()).toEqual({ error: 'invalid_value' });

    // 5. Invalid string/secret value (e.g. passing a number for string)
    const res5 = await app.request('/api/v1/admin/settings/cors_origin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 123, reason: 'invalid val' }),
    });
    expect(res5.status).toBe(400);
    expect(await res5.json()).toEqual({ error: 'invalid_value' });

    // 6. Env-only/read-only setting rejects DB edits
    const res6 = await app.request('/api/v1/admin/settings/smtp_pass', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'super-secret-password', reason: 'updating credentials' }),
    });
    expect(res6.status).toBe(403);
    expect(await res6.json()).toEqual({ error: 'setting_read_only' });
  });

  it('POST /settings/:key blocks secret persistence for editable settings', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const customSecretDef = {
      key: 'test_secret_setting',
      label: 'Test secret setting',
      description: 'Temporary test-only secret setting.',
      kind: 'secret' as const,
      editable: true,
      source: 'db_with_env_override' as const,
    };
    runtimeSettingDefs.push(customSecretDef);
    runtimeSettingsByKey.set(customSecretDef.key, customSecretDef);

    try {
      const res = await app.request('/api/v1/admin/settings/test_secret_setting', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'plaintext-should-not-store', reason: 'security hardening test' }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'secret_setting_persistence_disabled' });

      const stored = db.prepare("SELECT value_json FROM admin_settings WHERE key = 'test_secret_setting'").get() as { value_json: string } | undefined;
      expect(stored).toBeUndefined();
    } finally {
      runtimeSettingsByKey.delete(customSecretDef.key);
      const idx = runtimeSettingDefs.findIndex((def) => def.key === customSecretDef.key);
      if (idx >= 0) runtimeSettingDefs.splice(idx, 1);
    }
  });

  it('GET /settings masks secret values sourced from admin_settings', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();
    db.prepare("INSERT INTO admin_settings (key, value_json) VALUES (?, ?)").run('test_secret_setting', JSON.stringify('raw-secret-value'));
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const customSecretDef = {
      key: 'test_secret_setting',
      label: 'Test secret setting',
      description: 'Temporary test-only secret setting.',
      kind: 'secret' as const,
      editable: false,
      source: 'db_with_env_override' as const,
    };
    runtimeSettingDefs.push(customSecretDef);
    runtimeSettingsByKey.set(customSecretDef.key, customSecretDef);

    try {
      const res = await app.request('/api/v1/admin/settings');
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ key: string; value: unknown; effectiveValue: unknown; envOverride: unknown }> };
      const row = body.items.find((item) => item.key === 'test_secret_setting');
      expect(row).toBeDefined();
      expect(row?.value).toBe('(set)');
      expect(row?.effectiveValue).toBe('(set)');
      expect(row?.envOverride).toBeNull();
    } finally {
      runtimeSettingsByKey.delete(customSecretDef.key);
      const idx = runtimeSettingDefs.findIndex((def) => def.key === customSecretDef.key);
      if (idx >= 0) runtimeSettingDefs.splice(idx, 1);
    }
  });

  it('GET /accounts lists accounts matching query q', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1),('u1','user_bob',0),('u2','user_alice',0)").run();
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const resAll = await app.request('/api/v1/admin/accounts');
    expect(resAll.status).toBe(200);
    const bodyAll = await resAll.json() as any;
    expect(bodyAll.items.length).toBe(3);

    const resBob = await app.request('/api/v1/admin/accounts?q=bob');
    expect(resBob.status).toBe(200);
    const bodyBob = await resBob.json() as any;
    expect(bodyBob.items.length).toBe(1);
    expect(bodyBob.items[0].username).toBe('user_bob');
  });

  it('POST /accounts/:id/disable and /enable disables/enables account, purges auth sessions, and audits', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin, is_disabled) VALUES ('a1','admin',1,0),('u1','victim',0,0)").run();
    db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES ('tok1','u1','2099-01-01 00:00:00')").run();
    db.prepare("INSERT INTO api_keys (id, account_id, key_hash, label) VALUES ('k1','u1','hash','label')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // Disable requires reason
    const resDisableNoReason = await app.request('/api/v1/admin/accounts/u1/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resDisableNoReason.status).toBe(400);

    // Disable success
    const resDisable = await app.request('/api/v1/admin/accounts/u1/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'abuse' }),
    });
    expect(resDisable.status).toBe(200);

    const u1Disabled = db.prepare("SELECT is_disabled FROM accounts WHERE id = 'u1'").get() as any;
    expect(u1Disabled.is_disabled).toBe(1);

    const sessions = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE account_id = 'u1'").get() as any;
    expect(sessions.count).toBe(0);

    const keys = db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE account_id = 'u1'").get() as any;
    expect(keys.count).toBe(0);

    const disableAudit = db.prepare("SELECT action_type, target_id, payload_json FROM admin_audit_log WHERE action_type = 'account.disable'").get() as any;
    expect(disableAudit.action_type).toBe('account.disable');
    expect(disableAudit.target_id).toBe('u1');
    expect(JSON.parse(disableAudit.payload_json)).toMatchObject({ level: 2, reason: 'abuse' });

    // Enable requires reason
    const resEnableNoReason = await app.request('/api/v1/admin/accounts/u1/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resEnableNoReason.status).toBe(400);

    // Enable success
    const resEnable = await app.request('/api/v1/admin/accounts/u1/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'appealed' }),
    });
    expect(resEnable.status).toBe(200);

    const u1Enabled = db.prepare("SELECT is_disabled FROM accounts WHERE id = 'u1'").get() as any;
    expect(u1Enabled.is_disabled).toBe(0);

    const enableAudit = db.prepare("SELECT action_type, target_id, payload_json FROM admin_audit_log WHERE action_type = 'account.enable'").get() as any;
    expect(enableAudit.action_type).toBe('account.enable');
    expect(enableAudit.target_id).toBe('u1');
    expect(JSON.parse(enableAudit.payload_json)).toMatchObject({ reason: 'appealed' });
  });

  it('GET /events/moderation-queue filters by state and POST /events/:id/moderate handles reason validation', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, moderation_state) VALUES ('e1','a1','E1','2026-01-01','2026-01-01 10:00:00','UTC','flagged')").run();
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, moderation_state) VALUES ('e2','a1','E2','2026-01-01','2026-01-01 10:00:00','UTC','visible')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // 1. Check filtering by visible state
    const resVisible = await app.request('/api/v1/admin/events/moderation-queue?state=visible');
    const bodyVisible = await resVisible.json() as any;
    expect(bodyVisible.items.map((item: any) => item.id)).toEqual(['e2']);

    // 2. Check empty state query param -> defaults to flagged
    const resAll = await app.request('/api/v1/admin/events/moderation-queue?state=');
    const bodyAll = await resAll.json() as any;
    expect(bodyAll.items.map((item: any) => item.id)).toEqual(['e1']);

    // 3. Moderate requires reason
    const resModerateNoReason = await app.request('/api/v1/admin/events/e1/moderate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'hidden' }),
    });
    expect(resModerateNoReason.status).toBe(400);

    const resModerateInvalidState = await app.request('/api/v1/admin/events/e1/moderate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'not-a-real-state', reason: 'reviewed' }),
    });
    expect(resModerateInvalidState.status).toBe(400);
    expect(await resModerateInvalidState.json()).toEqual({ error: 'invalid_moderation_state' });
  });

  it('POST /federation/block, GET /federation/blocks, and unblocking manages blocks and hides remote events', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES ('actor1', 'preferred1', 'http://inbox1', 'bad-domain.com')").run();
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, moderation_state) VALUES ('re1', 'actor1', 'Title1', '2026-01-01', '2026-01-01 10:00:00', 'offset_only', 'visible')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // 1. Try blocking with missing targets and reason
    const resMissingReason = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'domain', domain: 'bad-domain.com' }),
    });
    expect(resMissingReason.status).toBe(400);
    expect(await resMissingReason.json()).toEqual({ error: 'reason_required' });

    const resFail = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'domain', reason: 'policy' }),
    });
    expect(resFail.status).toBe(400);

    const resInvalidType = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'invalid-type', domain: 'bad-domain.com', reason: 'policy' }),
    });
    expect(resInvalidType.status).toBe(400);
    expect(await resInvalidType.json()).toEqual({ error: 'invalid_block_type' });

    const resActorWithoutActorUri = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'actor', domain: 'bad-domain.com', reason: 'policy' }),
    });
    expect(resActorWithoutActorUri.status).toBe(400);
    expect(await resActorWithoutActorUri.json()).toEqual({ error: 'block_target_required' });

    // 2. Block domain
    const resBlockDomain = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'domain', domain: 'bad-domain.com', reason: 'spam network' }),
    });
    expect(resBlockDomain.status).toBe(200);
    const blockDomainBody = await resBlockDomain.json() as any;
    expect(blockDomainBody.ok).toBe(true);
    expect(blockDomainBody.blockId).toBeDefined();

    // Verify events from the domain are hidden
    const remoteEvent = db.prepare("SELECT moderation_state FROM remote_events WHERE uri = 're1'").get() as any;
    expect(remoteEvent.moderation_state).toBe('hidden');

    const storedDomainBlock = db.prepare('SELECT block_type, actor_uri, domain, reason FROM federation_blocks WHERE id = ?').get(blockDomainBody.blockId) as {
      block_type: string;
      actor_uri: string | null;
      domain: string | null;
      reason: string;
    } | undefined;
    expect(storedDomainBlock).toEqual({
      block_type: 'domain',
      actor_uri: null,
      domain: 'bad-domain.com',
      reason: 'spam network',
    });

    // 3. GET /federation/blocks
    const resBlocks = await app.request('/api/v1/admin/federation/blocks');
    const blocksBody = await resBlocks.json() as any;
    expect(blocksBody.items.length).toBe(1);
    expect(blocksBody.items[0].domain).toBe('bad-domain.com');
    expect(blocksBody.items[0].reason).toBe('spam network');

    const blockAudit = db.prepare("SELECT target_type, target_id, payload_json FROM admin_audit_log WHERE action_type = 'federation.block' AND target_type = 'domain' AND target_id = ? LIMIT 1").get('bad-domain.com') as {
      target_type: string;
      target_id: string;
      payload_json: string;
    } | undefined;
    expect(blockAudit).toBeDefined();
    expect(blockAudit!.target_type).toBe('domain');
    expect(blockAudit!.target_id).toBe('bad-domain.com');
    expect(JSON.parse(blockAudit!.payload_json)).toEqual({ reason: 'spam network' });

    const resBlockActor = await app.request('/api/v1/admin/federation/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'actor', actorUri: ' actor1 ', domain: 'bad-domain.com', reason: 'target actor only' }),
    });
    expect(resBlockActor.status).toBe(200);
    const blockActorBody = await resBlockActor.json() as any;
    expect(blockActorBody.ok).toBe(true);

    const storedActorBlock = db.prepare('SELECT block_type, actor_uri, domain, reason FROM federation_blocks WHERE id = ?').get(blockActorBody.blockId) as {
      block_type: string;
      actor_uri: string | null;
      domain: string | null;
      reason: string;
    } | undefined;
    expect(storedActorBlock).toEqual({
      block_type: 'actor',
      actor_uri: 'actor1',
      domain: null,
      reason: 'target actor only',
    });

    const actorBlockAudit = db.prepare("SELECT target_type, target_id, payload_json FROM admin_audit_log WHERE action_type = 'federation.block' AND target_type = 'actor' AND target_id = ? LIMIT 1").get('actor1') as {
      target_type: string;
      target_id: string;
      payload_json: string;
    } | undefined;
    expect(actorBlockAudit).toBeDefined();
    expect(actorBlockAudit!.target_type).toBe('actor');
    expect(actorBlockAudit!.target_id).toBe('actor1');
    expect(JSON.parse(actorBlockAudit!.payload_json)).toEqual({ reason: 'target actor only' });

    // GET with query
    const resBlocksQuery = await app.request('/api/v1/admin/federation/blocks?q=bad-domain');
    const queryBody = await resBlocksQuery.json() as any;
    expect(queryBody.items.length).toBe(1);
    expect(queryBody.items[0].domain).toBe('bad-domain.com');

    // 4. Unblock requires reason
    const blockId = blockDomainBody.blockId;
    const resUnblockNoReason = await app.request(`/api/v1/admin/federation/blocks/${blockId}/unblock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resUnblockNoReason.status).toBe(400);

    // Unblock successfully
    const resUnblock = await app.request(`/api/v1/admin/federation/blocks/${blockId}/unblock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'cleared' }),
    });
    expect(resUnblock.status).toBe(200);
    const blockRow = db.prepare("SELECT is_active FROM federation_blocks WHERE id = ?").get(blockId) as any;
    expect(blockRow.is_active).toBe(0);
  });

  it('GET /federation/actors and /federation/domains lists details', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, fetch_status) VALUES ('actor1', 'pref1', 'http://inbox1', 'domain1.com', 'active')").run();
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, fetch_status) VALUES ('actor2', 'pref2', 'http://inbox2', 'domain2.com', 'error')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // Test actor listing
    const resActors = await app.request('/api/v1/admin/federation/actors?domain=domain1.com&status=active&q=pref1');
    expect(resActors.status).toBe(200);
    const actorsBody = await resActors.json() as any;
    expect(actorsBody.items.length).toBe(1);
    expect(actorsBody.items[0].uri).toBe('actor1');

    // Test domains listing
    const resDomains = await app.request('/api/v1/admin/federation/domains');
    expect(resDomains.status).toBe(200);
    const domainsBody = await resDomains.json() as any;
    expect(domainsBody.items.length).toBe(2);
    const d1 = domainsBody.items.find((d: any) => d.domain === 'domain1.com');
    expect(d1.actor_count).toBe(1);
    expect(d1.error_count).toBe(0);
    const d2 = domainsBody.items.find((d: any) => d.domain === 'domain2.com');
    expect(d2.actor_count).toBe(1);
    expect(d2.error_count).toBe(1);
  });

  it('GET, POST, and DELETE /federation/tombstones manages tombstoned objects', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // 1. Create tombstone validation errors
    const resFail1 = await app.request('/api/v1/admin/federation/tombstones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectType: 'event' }), // missing objectId, reason
    });
    expect(resFail1.status).toBe(400);

    const resFail2 = await app.request('/api/v1/admin/federation/tombstones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectType: 'event', objectId: 'evt1' }), // missing reason
    });
    expect(resFail2.status).toBe(400);

    // 2. Create tombstone successfully
    const resCreate = await app.request('/api/v1/admin/federation/tombstones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectType: 'event', objectId: 'evt1', reason: 'deleted upstream', expiresAt: '2027-01-01' }),
    });
    expect(resCreate.status).toBe(200);
    const createBody = await resCreate.json() as any;
    expect(createBody.ok).toBe(true);
    expect(createBody.id).toBeDefined();

    // 3. GET tombstones
    const resGet = await app.request('/api/v1/admin/federation/tombstones');
    const getBody = await resGet.json() as any;
    expect(getBody.items.length).toBe(1);
    expect(getBody.items[0].object_id).toBe('evt1');

    // GET with search query
    const resGetQuery = await app.request('/api/v1/admin/federation/tombstones?q=evt1');
    const getQueryBody = await resGetQuery.json() as any;
    expect(getQueryBody.items.length).toBe(1);

    // 4. Delete tombstone validation (requires reason)
    const tombstoneId = createBody.id;
    const resDeleteNoReason = await app.request(`/api/v1/admin/federation/tombstones/${tombstoneId}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resDeleteNoReason.status).toBe(400);

    const missingDeleteAuditCountBefore = (db.prepare("SELECT COUNT(*) as count FROM admin_audit_log WHERE action_type = 'federation.tombstone.delete'").get() as { count: number }).count;
    const resDeleteMissing = await app.request('/api/v1/admin/federation/tombstones/missing-id/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'cleanup missing row' }),
    });
    expect(resDeleteMissing.status).toBe(404);
    expect(await resDeleteMissing.json()).toEqual({ error: 'federation_tombstone_not_found' });
    const missingDeleteAuditCountAfter = (db.prepare("SELECT COUNT(*) as count FROM admin_audit_log WHERE action_type = 'federation.tombstone.delete'").get() as { count: number }).count;
    expect(missingDeleteAuditCountAfter).toBe(missingDeleteAuditCountBefore);

    // Delete tombstone successfully
    const resDelete = await app.request(`/api/v1/admin/federation/tombstones/${tombstoneId}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'undo deletion' }),
    });
    expect(resDelete.status).toBe(200);

    const count = db.prepare("SELECT COUNT(*) as count FROM federation_tombstones WHERE id = ?").get(tombstoneId) as any;
    expect(count.count).toBe(0);

    const deleteAudit = db.prepare("SELECT target_type, target_id, payload_json FROM admin_audit_log WHERE action_type = 'federation.tombstone.delete' ORDER BY created_at DESC LIMIT 1").get() as {
      target_type: string;
      target_id: string;
      payload_json: string;
    } | undefined;
    expect(deleteAudit).toEqual({
      target_type: 'event',
      target_id: 'evt1',
      payload_json: JSON.stringify({ reason: 'undo deletion' }),
    });
  });

  it('GET /security/login-lockouts retrieves lockouts list', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO login_attempts (username, attempts, locked_until, last_attempt) VALUES ('user1', 5, '2026-01-01', '2026-01-01')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/security/login-lockouts');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items.length).toBe(1);
    expect(body.items[0].username).toBe('user1');

    const resQuery = await app.request('/api/v1/admin/security/login-lockouts?q=user1');
    const queryBody = await resQuery.json() as any;
    expect(queryBody.items.length).toBe(1);
  });

  it('POST /scrapers/trigger queues job and audits', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const res = await app.request('/api/v1/admin/scrapers/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scraper: 'all', dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.runId).toBeDefined();

    const runRow = db.prepare("SELECT job_type, status, payload_json FROM admin_job_runs WHERE id = ?").get(body.runId) as any;
    expect(runRow.job_type).toBe('scraper');
    expect(runRow.status).toBe('queued');
    expect(JSON.parse(runRow.payload_json)).toEqual({ scraper: 'all', dryRun: true });

    const auditRow = db.prepare("SELECT action_type, target_type, target_id, payload_json FROM admin_audit_log WHERE action_type = 'scraper.trigger' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(auditRow.action_type).toBe('scraper.trigger');
    expect(auditRow.target_type).toBe('scraper');
    expect(auditRow.target_id).toBe('all');
    expect(JSON.parse(auditRow.payload_json)).toEqual({ dryRun: true });
  });

  it('GET /audit-log and GET /jobs/runs lists logged details', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json) VALUES ('id1', 'admin1', 'test_action', 'test_target', 'target1', '{}')").run();
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, created_by_account_id) VALUES ('j1', 'scraper', 'queued', 'admin1')").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    // Audit logs
    const resAudit = await app.request('/api/v1/admin/audit-log?action=test_action&actor=admin1&target=target1');
    expect(resAudit.status).toBe(200);
    const auditBody = await resAudit.json() as any;
    expect(auditBody.items.length).toBe(1);
    expect(auditBody.items[0].id).toBe('id1');

    // Jobs runs
    const resJobs = await app.request('/api/v1/admin/jobs/runs');
    expect(resJobs.status).toBe(200);
    const jobsBody = await resJobs.json() as any;
    expect(jobsBody.items.length).toBe(1);
    expect(jobsBody.items[0].id).toBe('j1');
  });

  it('supports environment overrides for settings', async () => {
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1','admin',1)").run();

    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id:'a1', username:'admin', displayName:null, isAdmin:true }); await next(); });
    app.route('/api/v1/admin', adminRoutes(db));

    const originalOpenRegs = process.env.OPEN_REGISTRATIONS;
    const originalSmtpSecure = process.env.SMTP_SECURE;
    const originalPort = process.env.PORT;
    const originalBaseUrl = process.env.BASE_URL;

    try {
      process.env.OPEN_REGISTRATIONS = 'false';
      process.env.SMTP_SECURE = 'true';
      process.env.PORT = '8080';
      process.env.BASE_URL = 'http://test-env.com';

      // 1. Check health reflects env override for openRegistrations
      const resHealth = await app.request('/api/v1/admin/health');
      const healthBody = await resHealth.json() as any;
      expect(healthBody.openRegistrations).toBe(false);
      expect(healthBody.openRegistrationsEnvOverride).toBe(false);

      // 2. Check settings reflects environmental overrides
      const resSettings = await app.request('/api/v1/admin/settings');
      const settingsBody = await resSettings.json() as any;

      const openRegsSetting = settingsBody.items.find((item: any) => item.key === 'open_registrations');
      expect(openRegsSetting.effectiveValue).toBe(false);
      expect(openRegsSetting.envOverride).toBe(false);
      expect(openRegsSetting.lockedByEnv).toBe(true);

      const smtpSecureSetting = settingsBody.items.find((item: any) => item.key === 'smtp_secure');
      expect(smtpSecureSetting.effectiveValue).toBe(true);

      const portSetting = settingsBody.items.find((item: any) => item.key === 'port');
      expect(portSetting.effectiveValue).toBe(8080);

      const baseUrlSetting = settingsBody.items.find((item: any) => item.key === 'base_url');
      expect(baseUrlSetting.effectiveValue).toBe('http://test-env.com');

    } finally {
      if (originalOpenRegs !== undefined) process.env.OPEN_REGISTRATIONS = originalOpenRegs; else delete process.env.OPEN_REGISTRATIONS;
      if (originalSmtpSecure !== undefined) process.env.SMTP_SECURE = originalSmtpSecure; else delete process.env.SMTP_SECURE;
      if (originalPort !== undefined) process.env.PORT = originalPort; else delete process.env.PORT;
      if (originalBaseUrl !== undefined) process.env.BASE_URL = originalBaseUrl; else delete process.env.BASE_URL;
    }
  });

  it('correctly prunes old audit logs based on retention settings', () => {
    const db = initDatabase(':memory:');
    
    // Insert some audit logs with different dates
    db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json, created_at) VALUES ('id1', 'admin1', 'action1', 'target', 't1', '{}', datetime('now', '-400 days'))").run();
    db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json, created_at) VALUES ('id2', 'admin1', 'action2', 'target', 't2', '{}', datetime('now', '-100 days'))").run();
    db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json, created_at) VALUES ('id3', 'admin1', 'action3', 'target', 't3', '{}', datetime('now'))").run();

    // 1. If retainDays is 0, no pruning occurs
    const result0 = cleanupAdminAuditLogs(db, { retainDays: 0 });
    expect(result0.deletedCount).toBe(0);
    expect(db.prepare("SELECT COUNT(*) as count FROM admin_audit_log").get() as { count: number }).toEqual({ count: 3 });

    // 2. Prune with 365 days retention (should delete id1)
    const result365 = cleanupAdminAuditLogs(db, { retainDays: 365 });
    expect(result365.deletedCount).toBe(1);
    
    const remainingAfter365 = db.prepare("SELECT id FROM admin_audit_log ORDER BY created_at DESC").all() as Array<{ id: string }>;
    expect(remainingAfter365.map(row => row.id)).toEqual(['id3', 'id2']);

    // 3. Prune with 50 days retention (should delete id2)
    const result50 = cleanupAdminAuditLogs(db, { retainDays: 50 });
    expect(result50.deletedCount).toBe(1);

    const remainingAfter50 = db.prepare("SELECT id FROM admin_audit_log ORDER BY created_at DESC").all() as Array<{ id: string }>;
    expect(remainingAfter50.map(row => row.id)).toEqual(['id3']);
  });

  it('correctly reads audit log retention settings with getEffectiveSetting', () => {
    const db = initDatabase(':memory:');
    
    // Default value check
    const defaultRetain = getEffectiveSetting<number>(db, 'audit_log_retain_days', 365);
    expect(defaultRetain).toBe(365);

    // DB value check
    db.prepare("INSERT INTO admin_settings (key, value_json) VALUES ('audit_log_retain_days', '180')").run();
    const dbRetain = getEffectiveSetting<number>(db, 'audit_log_retain_days', 365);
    expect(dbRetain).toBe(180);

    // Environment override check
    const originalEnv = process.env.AUDIT_LOG_RETAIN_DAYS;
    try {
      process.env.AUDIT_LOG_RETAIN_DAYS = '90';
      const envRetain = getEffectiveSetting<number>(db, 'audit_log_retain_days', 365);
      expect(envRetain).toBe(90);
    } finally {
      if (originalEnv !== undefined) process.env.AUDIT_LOG_RETAIN_DAYS = originalEnv; else delete process.env.AUDIT_LOG_RETAIN_DAYS;
    }
  });
});
