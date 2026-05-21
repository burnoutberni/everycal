import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import './SettingsPage.css';

type AnyObj = Record<string, any>;
type Account = { id: string; username: string; is_admin?: number; is_disabled?: number; account_type?: string; discoverable?: number; email_verified?: number; created_at?: string; is_bot?: number };
type ModerationItem = { id: string; title: string; start_at_utc?: string; end_at_utc?: string; moderation_state: string; moderation_reason?: string | null; moderated_at?: string | null; account_id?: string; created_by_account_id?: string | null; created_at?: string };
type FederationBlock = { id: string; block_type: 'actor' | 'domain'; actor_uri?: string | null; domain?: string | null; is_active?: number; created_at?: string };
type FederationActor = { uri: string; preferred_username?: string | null; domain: string; fetch_status?: string | null; last_fetched_at?: string | null; next_retry_at?: string | null; last_error?: string | null };
type FederationDomain = { domain: string; actor_count: number; error_count: number; gone_count: number; last_fetched_at?: string | null };
type FederationTombstone = { id: string; object_type: string; object_id: string; reason?: string | null; created_at?: string; expires_at?: string | null };
type LoginLockout = { username: string; attempts: number; locked_until?: string | null; last_attempt?: string | null };
type AdminSetting = { key: string; label: string; description?: string; kind?: 'boolean' | 'string' | 'number' | 'json'; value: boolean | string | number | null; effectiveValue: boolean | string | number; envOverride: boolean | string | number | null; lockedByEnv: boolean; editable?: boolean };
type JobRun = { id: string; job_type: string; status: string; payload_json?: string | null; result_json?: string | null; created_at?: string; started_at?: string | null; finished_at?: string | null };
type AuditItem = { id: string; admin_account_id: string; action_type: string; target_type: string; target_id: string; payload_json: string; created_at: string };
type ConfirmState = { open: boolean; title: string; description: string; reasonLabel: string; actionLabel: string; actionClassName?: string; requireReason?: boolean; loading?: boolean; reason: string; onConfirm: (reason: string) => Promise<void> };
type AdminSectionKey = 'settings' | 'accounts' | 'events' | 'federation' | 'security' | 'scrapers' | 'jobs' | 'audit';

export function AdminPage() {
  const { user } = useAuth();
  const [health, setHealth] = useState<AnyObj | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [moderationQueue, setModerationQueue] = useState<ModerationItem[]>([]);
  const [federationBlocks, setFederationBlocks] = useState<FederationBlock[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [loginLockouts, setLoginLockouts] = useState<LoginLockout[]>([]);
  const [federationActors, setFederationActors] = useState<FederationActor[]>([]);
  const [federationDomains, setFederationDomains] = useState<FederationDomain[]>([]);
  const [federationTombstones, setFederationTombstones] = useState<FederationTombstone[]>([]);
  const [accountQuery, setAccountQuery] = useState('');
  const [queueState, setQueueState] = useState('flagged');
  const [blockQuery, setBlockQuery] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [auditActor, setAuditActor] = useState('');
  const [auditTarget, setAuditTarget] = useState('');
  const [lockoutQuery, setLockoutQuery] = useState('');
  const [actorQuery, setActorQuery] = useState('');
  const [actorStatus, setActorStatus] = useState('');
  const [tombstoneType, setTombstoneType] = useState('remote_event');
  const [tombstoneObjectId, setTombstoneObjectId] = useState('');
  const [tombstoneReason, setTombstoneReason] = useState('');
  const [eventId, setEventId] = useState('');
  const [eventState, setEventState] = useState('visible');
  const [eventReason, setEventReason] = useState('');
  const [blockType, setBlockType] = useState<'actor' | 'domain'>('domain');
  const [blockValue, setBlockValue] = useState('');
  const [scraperName, setScraperName] = useState('');
  const [scraperDryRun, setScraperDryRun] = useState(true);
  const [revokeAccountId, setRevokeAccountId] = useState('');
  const [activeSection, setActiveSection] = useState<AdminSectionKey>('settings');
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    title: '',
    description: '',
    reasonLabel: 'Reason',
    actionLabel: 'Confirm',
    reason: '',
    requireReason: true,
    onConfirm: async () => {},
  });

  const sections = useMemo(() => ([
    ['settings', 'Settings'],
    ['accounts', 'Accounts'],
    ['events', 'Events'],
    ['federation', 'Federation'],
    ['security', 'Security'],
    ['scrapers', 'Scrapers'],
    ['jobs', 'Jobs'],
    ['audit', 'Audit'],
  ] as const), []);
  const queueFlaggedCount = useMemo(() => moderationQueue.filter((item) => item.moderation_state === 'flagged').length, [moderationQueue]);
  const blockedFederationCount = useMemo(() => federationBlocks.filter((item) => !!item.is_active).length, [federationBlocks]);
  const failedOrRetryingJobs = useMemo(() => jobRuns.filter((run) => /(fail|retry|error)/i.test(run.status)).length, [jobRuns]);
  const upSinceLabel = useMemo(() => {
    const uptimeSec = typeof health?.uptimeSec === 'number' ? health.uptimeSec : null;
    if (!uptimeSec) return 'Unknown';
    const startedAt = new Date(Date.now() - uptimeSec * 1000);
    return startedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }, [health]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id as typeof activeSection);
            break;
          }
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
    );
    sections.forEach(([id]) => {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  const scrollToSection = (id: AdminSectionKey) => {
    const el = sectionRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSection(id);
    }
  };

  async function adminFetch(path: string, init?: RequestInit) {
    const res = await fetch(path, { credentials: 'include', ...init });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  async function refreshHealth() {
    const data = await adminFetch('/api/v1/admin/health');
    setHealth(data);
  }

  async function refreshAudit(action = auditAction, actor = auditActor, target = auditTarget) {
    const params = new URLSearchParams();
    if (action.trim()) params.set('action', action.trim());
    if (actor.trim()) params.set('actor', actor.trim());
    if (target.trim()) params.set('target', target.trim());
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const data = await adminFetch(`/api/v1/admin/audit-log${suffix}`);
    setAudit(data.items || []);
  }

  async function refreshAccounts(q = accountQuery) {
    const data = await adminFetch(`/api/v1/admin/accounts?q=${encodeURIComponent(q)}`);
    setAccounts(data.items || []);
  }

  async function refreshModerationQueue(state = queueState) {
    const data = await adminFetch(`/api/v1/admin/events/moderation-queue?state=${encodeURIComponent(state)}`);
    setModerationQueue(data.items || []);
  }

  async function refreshFederationBlocks(q = blockQuery) {
    const suffix = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    const data = await adminFetch(`/api/v1/admin/federation/blocks${suffix}`);
    setFederationBlocks(data.items || []);
  }

  async function refreshJobRuns() {
    const data = await adminFetch('/api/v1/admin/jobs/runs');
    setJobRuns(data.items || []);
  }

  async function refreshSettings() {
    const data = await adminFetch('/api/v1/admin/settings');
    setSettings(data.items || []);
  }

  async function refreshLoginLockouts(q = lockoutQuery) {
    const suffix = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    const data = await adminFetch(`/api/v1/admin/security/login-lockouts${suffix}`);
    setLoginLockouts(data.items || []);
  }

  async function refreshFederationActors() {
    const params = new URLSearchParams();
    if (actorQuery.trim()) params.set('q', actorQuery.trim());
    if (actorStatus.trim()) params.set('status', actorStatus.trim());
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const data = await adminFetch(`/api/v1/admin/federation/actors${suffix}`);
    setFederationActors(data.items || []);
  }

  async function refreshFederationDomains() {
    const data = await adminFetch('/api/v1/admin/federation/domains');
    setFederationDomains(data.items || []);
  }

  async function refreshFederationTombstones() {
    const data = await adminFetch('/api/v1/admin/federation/tombstones');
    setFederationTombstones(data.items || []);
  }

  function openReasonModal(options: Omit<ConfirmState, 'open' | 'reason' | 'loading'>) {
    setConfirmState({ ...options, open: true, reason: '', loading: false });
  }

  async function submitReasonModal() {
    if (confirmState.requireReason && !confirmState.reason.trim()) {
      setError('Reason is required for this admin action');
      return;
    }
    try {
      setError(null);
      setConfirmState((prev) => ({ ...prev, loading: true }));
      await confirmState.onConfirm(confirmState.reason.trim());
      setConfirmState((prev) => ({ ...prev, open: false, loading: false }));
    } catch (e) {
      setConfirmState((prev) => ({ ...prev, loading: false }));
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!user?.isAdmin) return;
    refreshHealth().catch((e) => setError(String(e)));
    refreshAudit().catch(() => {});
    refreshAccounts('').catch(() => {});
    refreshModerationQueue('flagged').catch(() => {});
    refreshFederationBlocks('').catch(() => {});
    refreshFederationActors().catch(() => {});
    refreshFederationDomains().catch(() => {});
    refreshFederationTombstones().catch(() => {});
    refreshSettings().catch(() => {});
    refreshLoginLockouts('').catch(() => {});
    refreshJobRuns().catch(() => {});
  }, [user?.isAdmin]);

  if (!user?.isAdmin) return <div className='empty-state mt-3'><h2>Forbidden</h2><p>Admin access is required.</p></div>;
  if (error) return <div className='empty-state mt-3'><h2>Error</h2><p>{error}</p></div>;

  return <div className='settings-layout mt-3'>
    <aside className='settings-sidebar'>
      <nav className='settings-nav' aria-label='Admin sections'>
        {sections.map(([key, label]) => (
          <button
            key={key}
            type='button'
            className={`settings-nav-link ${activeSection === key ? 'active' : ''}`}
            onClick={() => scrollToSection(key)}
          >
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>

    <div className='settings-content'>
      <h1 className='settings-page-title'>Admin Console</h1>
      <p className='text-muted'>Operations center for moderation, federation controls, scraper jobs, and auditability.</p>
      {status ? <p className='text-sm' role='status'>{status}</p> : null}
      <section className='settings-section'>
        <div className='settings-card admin-overview-card'>
          <h2 className='settings-section-title mb-1'>Overview</h2>
          <div className='admin-overview-grid'>
            <button type='button' className='admin-overview-item' onClick={() => { setQueueState('flagged'); scrollToSection('events'); }}>
              <p className='admin-overview-label'>Flagged events</p>
              <p className='admin-overview-value'>{queueFlaggedCount}</p>
            </button>
            <button type='button' className='admin-overview-item' onClick={() => scrollToSection('federation')}>
              <p className='admin-overview-label'>Active federation blocks</p>
              <p className='admin-overview-value'>{blockedFederationCount}</p>
            </button>
            <button type='button' className='admin-overview-item' onClick={() => scrollToSection('jobs')}>
              <p className='admin-overview-label'>Failed or retrying jobs</p>
              <p className='admin-overview-value'>{failedOrRetryingJobs}</p>
            </button>
            <button type='button' className='admin-overview-item' onClick={() => scrollToSection('accounts')}>
              <p className='admin-overview-label'>Total accounts</p>
              <p className='admin-overview-value'>{typeof health?.accounts === 'number' ? health.accounts : '-'}</p>
            </button>
            <button type='button' className='admin-overview-item' onClick={() => scrollToSection('events')}>
              <p className='admin-overview-label'>Total events</p>
              <p className='admin-overview-value'>{typeof health?.events === 'number' ? health.events : '-'}</p>
            </button>
            <button type='button' className='admin-overview-item' onClick={() => refreshHealth().catch((e) => setError(String(e)))}>
              <p className='admin-overview-label'>Up since</p>
              <p className='admin-overview-value'>{upSinceLabel}</p>
            </button>
          </div>
        </div>
      </section>

    <section id='settings' ref={(el) => { sectionRefs.current.settings = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>Runtime settings</h2>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshSettings().catch((e) => setError(String(e)))}>Refresh</button>
      </div>
      <div className='stack-sm'>
        {settings.map((setting) => (
          <div key={setting.key} className='card'>
            <div className='flex justify-between items-center gap-1'>
              <div>
                <strong>{setting.label}</strong>
                <div className='text-sm text-muted'>
                  {typeof setting.effectiveValue === 'boolean'
                    ? `Current policy: ${setting.effectiveValue ? 'Enabled' : 'Disabled'}`
                    : `Current value: ${String(setting.effectiveValue)}`}
                  {setting.lockedByEnv ? ' · Locked by environment variable' : ''}
                </div>
                {setting.description ? <div className='text-sm text-muted'>{setting.description}</div> : null}
              </div>
              <div className='flex gap-1'>
                {typeof setting.effectiveValue === 'boolean' ? (
                  <label className='checkbox-label'>
                    <input
                      type='checkbox'
                      checked={setting.effectiveValue}
                      disabled={setting.lockedByEnv || !setting.editable}
                      onChange={(e) => {
                        const nextValue = e.target.checked;
                        openReasonModal({
                          title: `Set ${setting.label}`,
                          description: 'Writes DB-backed value. Environment override still takes precedence.',
                          reasonLabel: 'Change reason',
                          actionLabel: `Set ${nextValue ? 'enabled' : 'disabled'}`,
                          actionClassName: nextValue ? undefined : 'btn-danger',
                          requireReason: true,
                          onConfirm: async (reason) => {
                            await adminFetch(`/api/v1/admin/settings/${encodeURIComponent(setting.key)}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ value: nextValue, reason }),
                            });
                            setStatus(`Updated ${setting.label.toLowerCase()} to ${nextValue ? 'enabled' : 'disabled'}`);
                            await refreshSettings();
                            await refreshAudit();
                          },
                        });
                      }}
                    />
                    Enabled
                  </label>
                ) : (
                  <span className='text-sm text-muted'>Read-only</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      </div>
    </section>

    <section id='accounts' ref={(el) => { sectionRefs.current.accounts = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Accounts</h2>
      <p className='text-sm text-muted mb-1'>Search users, disable compromised accounts, and restore access when resolved.</p>
      <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshAccounts().catch((err) => setError(String(err))); }}>
        <input aria-label='Search accounts by username' placeholder='Search username' value={accountQuery} onChange={(e) => setAccountQuery(e.target.value)} />
        <button className='btn btn-primary' type='submit'>Search</button>
      </form>
      <div className='stack-sm'>
        {accounts.map((a) => (
          <div key={a.id} className='card'>
            <div className='flex justify-between items-center gap-1'>
                <div>
                  <strong>@{a.username}</strong>
                  <div className='text-sm text-muted'>id: {a.id} · admin: {String(!!a.is_admin)} · disabled: {String(!!a.is_disabled)}</div>
                </div>
              <div className='flex gap-1'>
                <button
                  className='btn btn-danger btn-sm'
                  disabled={!!a.is_disabled || pendingActionKey === `disable:${a.id}`}
                  onClick={() => {
                    openReasonModal({
                      title: `Disable @${a.username}`,
                      description: 'This revokes active sessions and API keys, and blocks new authentication.',
                      reasonLabel: 'Disable reason',
                      actionLabel: 'Disable account',
                      actionClassName: 'btn-danger',
                      requireReason: true,
                      onConfirm: async (reason) => {
                        setPendingActionKey(`disable:${a.id}`);
                        try {
                          await adminFetch(`/api/v1/admin/accounts/${a.id}/disable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
                        } finally {
                          setPendingActionKey(null);
                        }
                        setStatus(`Disabled @${a.username}`);
                        await refreshAccounts();
                        await refreshAudit();
                      },
                    });
                  }}
                >Disable</button>
                <button
                  className='btn btn-ghost btn-sm'
                  disabled={!a.is_disabled || pendingActionKey === `enable:${a.id}`}
                  onClick={() => {
                    openReasonModal({
                      title: `Enable @${a.username}`,
                      description: 'This restores account access for new sessions.',
                      reasonLabel: 'Enable reason',
                      actionLabel: 'Enable account',
                      requireReason: true,
                      onConfirm: async (reason) => {
                        setPendingActionKey(`enable:${a.id}`);
                        try {
                          await adminFetch(`/api/v1/admin/accounts/${a.id}/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
                        } finally {
                          setPendingActionKey(null);
                        }
                        setStatus(`Enabled @${a.username}`);
                        await refreshAccounts();
                        await refreshAudit();
                      },
                    });
                  }}
                >Enable</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      </div>
    </section>

    <section id='events' ref={(el) => { sectionRefs.current.events = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Event moderation</h2>
      <p className='text-sm text-muted mb-1'>Apply manual moderation by event ID and review recent queue items.</p>
      <form className='stack-sm' onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!eventReason.trim()) {
          setError('Reason is required for moderation actions');
          return;
        }
        await adminFetch(`/api/v1/admin/events/${encodeURIComponent(eventId)}/moderate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: eventState, reason: eventReason || undefined })
        });
        setStatus(`Event ${eventId} set to ${eventState}`);
        setEventReason('');
        refreshAudit().catch(() => {});
      }}>
        <input required placeholder='Event ID' value={eventId} onChange={(e) => setEventId(e.target.value)} />
        <select value={eventState} onChange={(e) => setEventState(e.target.value)}>
          <option value='visible'>visible</option>
          <option value='hidden'>hidden</option>
          <option value='flagged'>flagged</option>
        </select>
        <textarea placeholder='Reason (required)' value={eventReason} onChange={(e) => setEventReason(e.target.value)} />
        <button className='btn btn-primary' type='submit'>Apply moderation</button>
      </form>
      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1'>
          <h3 className='text-sm'>Moderation queue</h3>
          <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshModerationQueue().catch((e) => setError(String(e)))}>Refresh</button>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshModerationQueue().catch((err) => setError(String(err))); }}>
          <select value={queueState} onChange={(e) => setQueueState(e.target.value)}>
            <option value='flagged'>flagged</option>
            <option value='hidden'>hidden</option>
            <option value='visible'>visible</option>
          </select>
          <button className='btn btn-primary' type='submit'>Load queue</button>
        </form>
        <div className='stack-sm'>
          {moderationQueue.map((item) => (
            <div key={item.id} className='card'>
              <div className='flex justify-between items-start gap-1'>
                <div>
                  <strong>{item.title || item.id}</strong>
                  <div className='text-sm text-muted'>id: {item.id} · state: {item.moderation_state} · start: {item.start_at_utc || 'n/a'}</div>
                </div>
                <button className='btn btn-ghost btn-sm' onClick={() => setEventId(item.id)}>Use ID</button>
              </div>
            </div>
          ))}
          {!moderationQueue.length ? <p className='text-sm text-muted'>No items for state: {queueState}.</p> : null}
        </div>
      </div>
      </div>
    </section>

    <section id='security' ref={(el) => { sectionRefs.current.security = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Security and abuse</h2>
      <p className='text-sm text-muted mb-1'>Investigate lockouts and revoke tokens when account access is compromised.</p>
      <div className='mb-1'>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshLoginLockouts().catch((err) => setError(String(err))); }}>
          <input placeholder='Search lockouts by username' value={lockoutQuery} onChange={(e) => setLockoutQuery(e.target.value)} />
          <button className='btn btn-primary' type='submit'>Search</button>
        </form>
        <div className='stack-sm'>
          {loginLockouts.map((lockout) => (
            <div key={lockout.username} className='card'>
              <div className='flex justify-between items-center gap-1'>
                <div>
                  <strong>@{lockout.username}</strong>
                  <div className='text-sm text-muted'>attempts: {lockout.attempts} · locked until: {lockout.locked_until || 'not locked'} · last attempt: {lockout.last_attempt || 'n/a'}</div>
                </div>
                <button className='btn btn-ghost btn-sm' onClick={() => {
                  openReasonModal({
                    title: `Reset lockout for @${lockout.username}`,
                    description: 'This clears failed login attempts and lock timers for this username.',
                    reasonLabel: 'Reset reason',
                    actionLabel: 'Reset lockout',
                    requireReason: true,
                    onConfirm: async (reason) => {
                      await adminFetch(`/api/v1/admin/security/login-lockouts/${encodeURIComponent(lockout.username)}/reset`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason }),
                      });
                      setStatus(`Reset lockout state for @${lockout.username}`);
                      await refreshLoginLockouts();
                      await refreshAudit();
                    },
                  });
                }}>Reset lockout</button>
              </div>
            </div>
          ))}
          {!loginLockouts.length ? <p className='text-sm text-muted'>No login lockout records found.</p> : null}
        </div>
      </div>
      <div>
        <h3 className='text-sm mb-1'>Revoke account auth</h3>
        <form className='flex gap-1' onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const accountId = revokeAccountId.trim();
          if (!accountId) {
            setError('Provide an account id to revoke authentication.');
            return;
          }
          openReasonModal({
            title: `Revoke auth for account ${accountId}`,
            description: 'This revokes all sessions and API keys for the account.',
            reasonLabel: 'Revocation reason',
            actionLabel: 'Revoke auth',
            actionClassName: 'btn-danger',
            requireReason: true,
            onConfirm: async (reason) => {
              const data = await adminFetch(`/api/v1/admin/security/accounts/${encodeURIComponent(accountId)}/revoke-auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
              });
              setStatus(`Revoked auth for ${accountId} (sessions: ${data.revokedSessions}, api keys: ${data.revokedApiKeys})`);
              await refreshAudit();
            },
          });
        }}>
          <input placeholder='Account ID' value={revokeAccountId} onChange={(e) => setRevokeAccountId(e.target.value)} />
          <button className='btn btn-danger' type='submit'>Revoke auth now</button>
        </form>
      </div>
      </div>
    </section>

    <section id='federation' ref={(el) => { sectionRefs.current.federation = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Federation blocklist</h2>
      <p className='text-sm text-muted mb-1'>Manage remote trust and content suppression in one place.</p>
      <form className='stack-sm' onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const payload = blockType === 'domain' ? { blockType, domain: blockValue } : { blockType, actorUri: blockValue };
        await adminFetch('/api/v1/admin/federation/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        setStatus(`Blocked ${blockType}: ${blockValue}`);
        setBlockValue('');
        refreshAudit().catch(() => {});
      }}>
        <select value={blockType} onChange={(e) => setBlockType(e.target.value as 'actor' | 'domain')}>
          <option value='domain'>Domain</option>
          <option value='actor'>Actor URI</option>
        </select>
        <input required placeholder={blockType === 'domain' ? 'example.org' : 'https://remote.example/users/alice'} value={blockValue} onChange={(e) => setBlockValue(e.target.value)} />
        <button className='btn btn-danger' type='submit'>Block now</button>
      </form>
      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1'>
          <h3 className='text-sm'>Active and recent blocks</h3>
          <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshFederationBlocks().catch((e) => setError(String(e)))}>Refresh</button>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshFederationBlocks().catch((err) => setError(String(err))); }}>
          <input placeholder='Search domain or actor URI' value={blockQuery} onChange={(e) => setBlockQuery(e.target.value)} />
          <button className='btn btn-primary' type='submit'>Search</button>
        </form>
        <div className='stack-sm'>
          {federationBlocks.map((b) => (
            <div key={b.id} className='card'>
              <div className='flex justify-between items-center gap-1'>
                <div>
                  <strong>{b.block_type === 'domain' ? b.domain : b.actor_uri}</strong>
                  <div className='text-sm text-muted'>id: {b.id} · type: {b.block_type} · active: {String(!!b.is_active)}</div>
                </div>
                <button
                  className='btn btn-ghost btn-sm'
                  disabled={!b.is_active || pendingActionKey === `unblock:${b.id}`}
                  onClick={() => {
                    openReasonModal({
                      title: 'Unblock federation target',
                      description: 'Unblocking does not automatically re-import previously hidden content.',
                      reasonLabel: 'Unblock reason',
                      actionLabel: 'Unblock',
                      requireReason: true,
                      onConfirm: async (reason) => {
                        setPendingActionKey(`unblock:${b.id}`);
                        try {
                          await adminFetch(`/api/v1/admin/federation/blocks/${b.id}/unblock`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reason }),
                          });
                        } finally {
                          setPendingActionKey(null);
                        }
                        setStatus(`Unblocked ${b.block_type}: ${b.domain || b.actor_uri}`);
                        await refreshFederationBlocks();
                        await refreshAudit();
                      },
                    });
                  }}
                >Unblock</button>
              </div>
            </div>
          ))}
          {!federationBlocks.length ? <p className='text-sm text-muted'>No federation blocks found.</p> : null}
        </div>
      </div>
      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1'>
          <h3 className='text-sm'>Remote actor diagnostics</h3>
          <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshFederationActors().catch((e) => setError(String(e)))}>Refresh</button>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshFederationActors().catch((err) => setError(String(err))); }}>
          <input placeholder='Search URI, domain, or username' value={actorQuery} onChange={(e) => setActorQuery(e.target.value)} />
          <select value={actorStatus} onChange={(e) => setActorStatus(e.target.value)}>
            <option value=''>all statuses</option>
            <option value='active'>active</option>
            <option value='error'>error</option>
            <option value='gone'>gone</option>
          </select>
          <button className='btn btn-primary' type='submit'>Filter</button>
        </form>
        <div className='stack-sm'>
          {federationActors.slice(0, 50).map((actor) => (
            <div key={actor.uri} className='card'>
              <strong>{actor.preferred_username || actor.uri}</strong>
              <div className='text-sm text-muted'>domain: {actor.domain} · status: {actor.fetch_status || 'active'} · retry: {actor.next_retry_at || 'n/a'}</div>
              {actor.last_error ? <div className='text-sm text-muted'>last error: {actor.last_error}</div> : null}
            </div>
          ))}
        </div>
      </div>
      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1'>
          <h3 className='text-sm'>Federation domains</h3>
          <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshFederationDomains().catch((e) => setError(String(e)))}>Refresh</button>
        </div>
        <div className='stack-sm'>
          {federationDomains.slice(0, 50).map((domain) => (
            <div key={domain.domain} className='card'>
              <strong>{domain.domain}</strong>
              <div className='text-sm text-muted'>actors: {domain.actor_count} · errors: {domain.error_count} · gone: {domain.gone_count}</div>
            </div>
          ))}
        </div>
      </div>
      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1'>
          <h3 className='text-sm'>Federation tombstones</h3>
          <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshFederationTombstones().catch((e) => setError(String(e)))}>Refresh</button>
        </div>
        <form className='stack-sm mb-1' onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (!tombstoneObjectId.trim() || !tombstoneReason.trim()) {
            setError('Tombstone object id and reason are required');
            return;
          }
          await adminFetch('/api/v1/admin/federation/tombstones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ objectType: tombstoneType, objectId: tombstoneObjectId.trim(), reason: tombstoneReason.trim() }),
          });
          setStatus(`Created tombstone for ${tombstoneType}:${tombstoneObjectId}`);
          setTombstoneObjectId('');
          setTombstoneReason('');
          await refreshFederationTombstones();
          await refreshAudit();
        }}>
          <select value={tombstoneType} onChange={(e) => setTombstoneType(e.target.value)}>
            <option value='remote_event'>remote_event</option>
            <option value='remote_actor'>remote_actor</option>
            <option value='activity'>activity</option>
          </select>
          <input placeholder='Object ID or URI' value={tombstoneObjectId} onChange={(e) => setTombstoneObjectId(e.target.value)} />
          <textarea placeholder='Reason (required)' value={tombstoneReason} onChange={(e) => setTombstoneReason(e.target.value)} />
          <button className='btn btn-primary' type='submit'>Create tombstone</button>
        </form>
        <div className='stack-sm'>
          {federationTombstones.slice(0, 50).map((stone) => (
            <div key={stone.id} className='card'>
              <div className='flex justify-between items-start gap-1'>
                <div>
                  <strong>{stone.object_type}: {stone.object_id}</strong>
                  <div className='text-sm text-muted'>created: {stone.created_at || 'n/a'} · expires: {stone.expires_at || 'none'}</div>
                  {stone.reason ? <div className='text-sm text-muted'>reason: {stone.reason}</div> : null}
                </div>
                <button className='btn btn-ghost btn-sm' onClick={() => {
                  openReasonModal({
                    title: 'Delete tombstone',
                    description: 'This allows future federation fetch of the object again.',
                    reasonLabel: 'Deletion reason',
                    actionLabel: 'Delete',
                    requireReason: true,
                    onConfirm: async (reason) => {
                      await adminFetch(`/api/v1/admin/federation/tombstones/${stone.id}/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason }),
                      });
                      setStatus(`Deleted tombstone ${stone.id}`);
                      await refreshFederationTombstones();
                      await refreshAudit();
                    },
                  });
                }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </section>

    <section id='scrapers' ref={(el) => { sectionRefs.current.scrapers = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Trigger scraper run</h2>
      <p className='text-sm text-muted mb-1'>Queue collection jobs. Keep dry run enabled for verification before live ingestion.</p>
      <form className='stack-sm' onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const data = await adminFetch('/api/v1/admin/scrapers/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scraper: scraperName || undefined, dryRun: scraperDryRun }) });
        setStatus(`Queued scraper run ${data.runId} (${scraperDryRun ? 'dry-run' : 'live'})`);
        refreshAudit().catch(() => {});
      }}>
        <input placeholder='Scraper name (optional)' value={scraperName} onChange={(e) => setScraperName(e.target.value)} />
        <label className='checkbox-label'><input type='checkbox' checked={scraperDryRun} onChange={(e) => setScraperDryRun(e.target.checked)} />Dry run</label>
        <button className='btn btn-primary' type='submit'>Queue run</button>
      </form>
      </div>
    </section>

    <section id='jobs' ref={(el) => { sectionRefs.current.jobs = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>Job runs</h2>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshJobRuns().catch((e) => setError(String(e)))}>Refresh</button>
      </div>
      <p className='text-sm text-muted mb-1'>Recent execution history for admin-triggered background work.</p>
      <div className='stack-sm'>
        {jobRuns.map((run) => (
          <div key={run.id} className='card'>
            <strong>{run.job_type}</strong>
            <div className='text-sm text-muted'>id: {run.id} · status: {run.status} · created: {run.created_at || 'n/a'}</div>
          </div>
        ))}
        {!jobRuns.length ? <p className='text-sm text-muted'>No admin-triggered jobs yet.</p> : null}
      </div>
      </div>
    </section>

    <section id='audit' ref={(el) => { sectionRefs.current.audit = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>Audit trail</h2>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshAudit().catch((e) => setError(String(e)))}>Refresh</button>
      </div>
      <p className='text-sm text-muted mb-1'>Immutable log for sensitive admin actions and moderation decisions.</p>
      <form className='stack-sm mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshAudit().catch((err) => setError(String(err))); }}>
        <input placeholder='Filter action (e.g. account.disable)' value={auditAction} onChange={(e) => setAuditAction(e.target.value)} />
        <input placeholder='Filter actor account ID' value={auditActor} onChange={(e) => setAuditActor(e.target.value)} />
        <input placeholder='Filter target ID' value={auditTarget} onChange={(e) => setAuditTarget(e.target.value)} />
        <button className='btn btn-primary' type='submit'>Apply filters</button>
      </form>
      <div className='stack-sm'>
        {audit.slice(0, 100).map((item) => (
          <div key={item.id} className='card'>
            <strong>{item.action_type}</strong>
            <div className='text-sm text-muted'>admin: {item.admin_account_id} · target: {item.target_type}:{item.target_id} · at: {item.created_at}</div>
            <pre>{item.payload_json}</pre>
          </div>
        ))}
        {!audit.length ? <p className='text-sm text-muted'>No audit entries match the active filters.</p> : null}
      </div>
      </div>
    </section>
    </div>
    {confirmState.open ? (
      <div className='modal-overlay' role='dialog' aria-modal='true' aria-labelledby='admin-confirm-title' onClick={(e) => {
        if (e.target === e.currentTarget) setConfirmState((prev) => ({ ...prev, open: false, loading: false }));
      }}>
        <div className='modal-card'>
          <div className='modal-header'>
            <h2 id='admin-confirm-title' style={{ fontSize: '1rem', fontWeight: 600 }}>{confirmState.title}</h2>
            <button type='button' className='btn btn-ghost btn-sm' onClick={() => setConfirmState((prev) => ({ ...prev, open: false, loading: false }))}>Close</button>
          </div>
          <div className='modal-body'>
            <p className='text-sm text-muted'>{confirmState.description}</p>
            <label className='settings-label' htmlFor='admin-action-reason'>{confirmState.reasonLabel}</label>
            <textarea
              id='admin-action-reason'
              placeholder='Required reason for audit trail'
              value={confirmState.reason}
              onChange={(e) => setConfirmState((prev) => ({ ...prev, reason: e.target.value }))}
            />
            <div className='flex justify-end gap-1 mt-2'>
              <button type='button' className='btn btn-ghost' onClick={() => setConfirmState((prev) => ({ ...prev, open: false, loading: false }))}>Cancel</button>
              <button
                type='button'
                className={`btn ${confirmState.actionClassName || 'btn-primary'}`}
                disabled={!!confirmState.loading}
                onClick={() => submitReasonModal().catch((e) => setError(String(e)))}
              >{confirmState.loading ? 'Working…' : confirmState.actionLabel}</button>
            </div>
          </div>
        </div>
      </div>
    ) : null}
  </div>;
}
