import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import './SettingsPage.css';

type AnyObj = Record<string, any>;
type Account = { id: string; username: string; is_admin?: number; is_disabled?: number; account_type?: string; discoverable?: number; email_verified?: number; created_at?: string; is_bot?: number };
type ModerationItem = { id: string; title: string; start_at_utc?: string; end_at_utc?: string; moderation_state: string; moderation_reason?: string | null; moderated_at?: string | null; account_id?: string; created_by_account_id?: string | null; created_at?: string };
type FederationBlock = { id: string; block_type: 'actor' | 'domain'; actor_uri?: string | null; domain?: string | null; is_active?: number; created_at?: string };
type JobRun = { id: string; job_type: string; status: string; payload_json?: string | null; result_json?: string | null; created_at?: string; started_at?: string | null; finished_at?: string | null };
type AuditItem = { id: string; admin_account_id: string; action_type: string; target_type: string; target_id: string; payload_json: string; created_at: string };
type ConfirmState = { open: boolean; title: string; description: string; reasonLabel: string; actionLabel: string; actionClassName?: string; requireReason?: boolean; loading?: boolean; reason: string; onConfirm: (reason: string) => Promise<void> };

function flattenHealthMetrics(value: unknown, prefix = ''): Array<{ key: string; label: string; value: string; state: 'good' | 'warn' | 'bad' | 'neutral' }> {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const count = value.length;
    return [{ key: prefix || 'items', label: prefix || 'Items', value: String(count), state: count > 0 ? 'warn' : 'neutral' }];
  }
  if (typeof value === 'object') {
    const rows: Array<{ key: string; label: string; value: string; state: 'good' | 'warn' | 'bad' | 'neutral' }> = [];
    Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        rows.push(...flattenHealthMetrics(v, key));
      } else {
        const normalized = typeof v === 'boolean' ? (v ? 'healthy' : 'unhealthy') : String(v);
        const low = normalized.toLowerCase();
        const state = /(error|fail|down|unhealthy|blocked)/.test(low)
          ? 'bad'
          : /(warn|degraded|slow|pending|retry)/.test(low)
            ? 'warn'
            : /(ok|healthy|up|ready|running|pass)/.test(low)
              ? 'good'
              : 'neutral';
        rows.push({
          key,
          label: key.replace(/[_\.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          value: normalized,
          state,
        });
      }
    });
    return rows;
  }
  return [{ key: prefix || 'status', label: prefix || 'Status', value: String(value), state: 'neutral' }];
}

export function AdminPage() {
  const { user } = useAuth();
  const [health, setHealth] = useState<AnyObj | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [moderationQueue, setModerationQueue] = useState<ModerationItem[]>([]);
  const [federationBlocks, setFederationBlocks] = useState<FederationBlock[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [accountQuery, setAccountQuery] = useState('');
  const [queueState, setQueueState] = useState('flagged');
  const [blockQuery, setBlockQuery] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [auditActor, setAuditActor] = useState('');
  const [auditTarget, setAuditTarget] = useState('');
  const [eventId, setEventId] = useState('');
  const [eventState, setEventState] = useState('visible');
  const [eventReason, setEventReason] = useState('');
  const [blockType, setBlockType] = useState<'actor' | 'domain'>('domain');
  const [blockValue, setBlockValue] = useState('');
  const [scraperName, setScraperName] = useState('');
  const [scraperDryRun, setScraperDryRun] = useState(true);
  const [activeSection, setActiveSection] = useState<'health' | 'accounts' | 'events' | 'federation' | 'scrapers' | 'jobs' | 'audit'>('health');
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
    ['health', 'Health'],
    ['accounts', 'Accounts'],
    ['events', 'Events'],
    ['federation', 'Federation'],
    ['scrapers', 'Scrapers'],
    ['jobs', 'Jobs'],
    ['audit', 'Audit'],
  ] as const), []);
  const healthMetrics = useMemo(() => flattenHealthMetrics(health), [health]);
  const healthSummary = useMemo(() => {
    const bad = healthMetrics.filter((m) => m.state === 'bad').length;
    const warn = healthMetrics.filter((m) => m.state === 'warn').length;
    const good = healthMetrics.filter((m) => m.state === 'good').length;
    return { bad, warn, good, total: healthMetrics.length };
  }, [healthMetrics]);

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

  const scrollToSection = (id: typeof activeSection) => {
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

    <section id='health' ref={(el) => { sectionRefs.current.health = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>System health</h2>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => refreshHealth().catch((e) => setError(String(e)))}>Refresh</button>
      </div>
      <div className='admin-health-wrap'>
        <div className='admin-health-header'>
          <div className='admin-health-kpi admin-health-kpi-bad'><span>Critical</span><strong>{healthSummary.bad}</strong></div>
          <div className='admin-health-kpi admin-health-kpi-warn'><span>Warnings</span><strong>{healthSummary.warn}</strong></div>
          <div className='admin-health-kpi admin-health-kpi-good'><span>Healthy</span><strong>{healthSummary.good}</strong></div>
          <div className='admin-health-kpi'><span>Total Signals</span><strong>{healthSummary.total}</strong></div>
        </div>
        <div className='admin-health-grid'>
          {healthMetrics.map((m) => (
            <article key={m.key} className={`admin-health-metric is-${m.state}`}>
              <p className='admin-health-metric-label'>{m.label}</p>
              <p className='admin-health-metric-value'>{m.value}</p>
            </article>
          ))}
        </div>
      </div>
      </div>
    </section>

    <section id='accounts' ref={(el) => { sectionRefs.current.accounts = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Accounts</h2>
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
      <h2 className='settings-section-title mb-1'>Moderate event</h2>
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

    <section id='federation' ref={(el) => { sectionRefs.current.federation = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Federation blocklist</h2>
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
      </div>
    </section>

    <section id='scrapers' ref={(el) => { sectionRefs.current.scrapers = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Trigger scraper run</h2>
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
