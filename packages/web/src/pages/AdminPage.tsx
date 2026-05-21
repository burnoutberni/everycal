import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toErrorMessage } from '@everycal/core';
import { useLocation } from 'wouter';
import { useAuth } from '../hooks/useAuth';
import { CalendarIcon, CheckCalendarIcon, FlagIcon, GlobeIcon, SettingsIcon, ShieldIcon, TimerIcon, UpdateIcon, UserIcon } from '../components/icons';
import { ModerationDecisionActions } from '../components/ModerationDecisionActions';
import './SettingsPage.css';

type AnyObj = Record<string, any>;
type Account = { id: string; username: string; is_admin?: number; is_disabled?: number; is_locked_out?: number; account_type?: string; discoverable?: number; email_verified?: number; created_at?: string; is_bot?: number };
type ModerationItem = {
  id: string;
  slug?: string | null;
  title: string;
  description?: string | null;
  start_at_utc?: string;
  end_at_utc?: string;
  event_timezone?: string | null;
  all_day?: number;
  location_name?: string | null;
  location_address?: string | null;
  url?: string | null;
  visibility?: string;
  canceled?: number;
  moderation_state: string;
  moderation_reason?: string | null;
  moderated_at?: string | null;
  account_id?: string;
  created_by_account_id?: string | null;
  owner_username?: string | null;
  created_by_username?: string | null;
  tags?: string | null;
  created_at?: string;
  updated_at?: string;
};
type FederationBlock = { id: string; block_type: 'actor' | 'domain'; actor_uri?: string | null; domain?: string | null; is_active?: number; created_at?: string };
type FederationActor = { uri: string; preferred_username?: string | null; domain: string; fetch_status?: string | null; last_fetched_at?: string | null; next_retry_at?: string | null; last_error?: string | null };
type FederationDomain = { domain: string; actor_count: number; error_count: number; gone_count: number; last_fetched_at?: string | null };
type FederationTombstone = { id: string; object_type: string; object_id: string; reason?: string | null; created_at?: string; expires_at?: string | null };
type AdminSetting = { key: string; label: string; description?: string; kind?: 'boolean' | 'string' | 'number' | 'json' | 'secret'; value: boolean | string | number | null; effectiveValue: boolean | string | number | null; envOverride: boolean | string | number | null; lockedByEnv: boolean; editable?: boolean; applyScope?: 'immediate' | 'next_worker_tick' | 'restart_required' };
type JobRun = { id: string; job_type: string; status: string; payload_json?: string | null; result_json?: string | null; created_at?: string; started_at?: string | null; finished_at?: string | null };
type AuditItem = { id: string; admin_account_id: string; action_type: string; target_type: string; target_id: string; payload_json: string; created_at: string };
type ConfirmState = { open: boolean; title: string; description: string; reasonLabel: string; actionLabel: string; actionClassName?: string; requireReason?: boolean; loading?: boolean; reason: string; onConfirm: (reason: string) => Promise<void> };
type AdminSectionKey = 'settings' | 'accounts' | 'events' | 'federation' | 'scrapers' | 'jobs' | 'audit';

type ScraperInfo = {
  id: string;
  name: string;
  url: string;
  description: string;
};

const AVAILABLE_SCRAPERS: ScraperInfo[] = [
  { id: 'all', name: 'All Scrapers', url: 'N/A', description: 'Run all configured scrapers in sequence' },
  { id: 'flex-at', name: 'Flex Vienna', url: 'https://flex.at', description: 'Scrapes electronic, indie, and rock music concert listings' },
  { id: 'critical-mass-vienna', name: 'Critical Mass Vienna', url: 'https://criticalmass.at', description: 'Scrapes monthly critical mass cycling event details' },
  { id: 'radlobby-wien', name: 'Radlobby Wien', url: 'https://www.radlobby.at/wien', description: 'Scrapes community cycling events, workshops, and gatherings' },
  { id: 'matznerviertel', name: 'Matznerviertel', url: 'https://matznerviertel.at', description: 'Scrapes neighbourhood initiatives, meetings, and cultural events' },
  { id: 'space-and-place', name: 'space and place', url: 'https://www.spaceandplace.at', description: 'Scrapes urban art, walks, and collaborative public projects' },
  { id: 'kirchberggasse', name: 'Kirchberggasse', url: 'https://kirchberggasse.at', description: 'Scrapes local gallery exhibition listings and street parties' },
  { id: 'westbahnpark', name: 'Westbahnpark', url: 'https://westbahnpark.at', description: 'Scrapes green initiative meetings and park events' },
  { id: 'geht-doch', name: 'Geht doch', url: 'https://geht-doch.wien', description: 'Scrapes local active mobility actions and meetings' },
];

export function AdminPage() {
  const { user, authStatus } = useAuth();
  const [, navigate] = useLocation();
  const [health, setHealth] = useState<AnyObj | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [moderationQueue, setModerationQueue] = useState<ModerationItem[]>([]);
  const [federationBlocks, setFederationBlocks] = useState<FederationBlock[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [federationActors, setFederationActors] = useState<FederationActor[]>([]);
  const [federationDomains, setFederationDomains] = useState<FederationDomain[]>([]);
  const [federationTombstones, setFederationTombstones] = useState<FederationTombstone[]>([]);
  const [accountQuery, setAccountQuery] = useState('');
  const [queueState, setQueueState] = useState('flagged');
  const [blockQuery, setBlockQuery] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [auditActor, setAuditActor] = useState('');
  const [auditTarget, setAuditTarget] = useState('');
  const [actorQuery, setActorQuery] = useState('');
  const [actorStatus, setActorStatus] = useState('');
  const [domainQuery, setDomainQuery] = useState('');
  const [proactiveType, setProactiveType] = useState('domain');
  const [proactiveTarget, setProactiveTarget] = useState('');
  const [proactiveReason, setProactiveReason] = useState('');
  const [scraperDryRun, setScraperDryRun] = useState(true);
  const [activeSection, setActiveSection] = useState<AdminSectionKey>('settings');
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshCountdownSec, setRefreshCountdownSec] = useState(60);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [runtimeDraftValues, setRuntimeDraftValues] = useState<Record<string, string>>({});
  const [runtimeSettingsQuery, setRuntimeSettingsQuery] = useState('');
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

  useEffect(() => {
    if (authStatus === 'unknown') return;
    if (!user) {
      navigate('/login?next=%2Fadmin&notice=admin-required');
      return;
    }
    if (!user.isAdmin) {
      navigate('/settings?notice=admin-required');
    }
  }, [authStatus, navigate, user]);

  const sections = useMemo(() => ([
    { key: 'accounts', label: 'Accounts', icon: <UserIcon /> },
    { key: 'events', label: 'Events', icon: <CalendarIcon /> },
    { key: 'federation', label: 'Federation', icon: <GlobeIcon /> },
    { key: 'scrapers', label: 'Scrapers', icon: <UpdateIcon /> },
    { key: 'jobs', label: 'Jobs', icon: <TimerIcon /> },
    { key: 'audit', label: 'Audit', icon: <ShieldIcon /> },
    { key: 'settings', label: 'Settings', icon: <SettingsIcon /> },
  ] as const), []);
  const queueFlaggedCount = useMemo(() => moderationQueue.filter((item) => item.moderation_state === 'flagged').length, [moderationQueue]);
  const blockedFederationCount = useMemo(() => federationBlocks.filter((item) => !!item.is_active).length, [federationBlocks]);
  const failedOrRetryingJobs = useMemo(() => jobRuns.filter((run) => /(fail|retry|error)/i.test(run.status)).length, [jobRuns]);
  const filteredDomains = useMemo(() => {
    const q = domainQuery.trim().toLowerCase();
    if (!q) return federationDomains;
    return federationDomains.filter((d) => d.domain.toLowerCase().includes(q));
  }, [federationDomains, domainQuery]);
  const combinedSuppressed = useMemo(() => {
    const blocks = federationBlocks.map((b) => ({
      id: b.id,
      type: 'block',
      subType: b.block_type,
      target: b.block_type === 'domain' ? b.domain : b.actor_uri,
      details: `type: ${b.block_type} · active: ${b.is_active ? 'yes' : 'no'}`,
      createdAt: b.created_at,
      isActive: !!b.is_active,
      reason: null as string | null,
    }));

    const stones = federationTombstones.map((s) => ({
      id: s.id,
      type: 'tombstone',
      subType: s.object_type,
      target: s.object_id,
      details: `type: tombstone (${s.object_type})`,
      createdAt: s.created_at,
      isActive: true,
      reason: s.reason || null,
    }));

    const all = [...blocks, ...stones].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    const q = blockQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((item) =>
      (item.target || '').toLowerCase().includes(q) ||
      (item.id || '').toLowerCase().includes(q) ||
      (item.reason || '').toLowerCase().includes(q)
    );
  }, [federationBlocks, federationTombstones, blockQuery]);
  const upSinceLabel = useMemo(() => {
    const uptimeSec = typeof health?.uptimeSec === 'number' ? health.uptimeSec : null;
    if (!uptimeSec) return 'Unknown';
    const startedAt = new Date(Date.now() - uptimeSec * 1000);
    return startedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }, [health]);
  const lastRefreshedLabel = useMemo(() => {
    if (!lastRefreshedAt) return 'Never';
    return lastRefreshedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, [lastRefreshedAt]);
  const formatDateTime = useCallback((value?: string | null) => {
    if (!value) return 'n/a';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }, []);
  const formatModerationLatency = useCallback((requestedAt?: string, moderatedAt?: string | null) => {
    if (!requestedAt) return '';
    const start = new Date(requestedAt);
    if (Number.isNaN(start.getTime())) return '';
    const end = moderatedAt ? new Date(moderatedAt) : new Date();
    if (Number.isNaN(end.getTime())) return '';
    const diffMs = end.getTime() - start.getTime();
    if (diffMs < 0) return '0m';
    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 1) return '<1m';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (!days && minutes) parts.push(`${minutes}m`);
    return parts.join(' ');
  }, []);
  const runtimeSettingGroups = useMemo(() => {
    const groupOrder = [
      'Access and trust',
      'Server and platform',
      'Federation and queues',
      'Email delivery',
      'Secrets and integrations',
      'Other',
    ] as const;
    const groups = new Map<string, AdminSetting[]>();

    for (const group of groupOrder) groups.set(group, []);

    const resolveGroup = (key: string) => {
      if (key === 'open_registrations' || key === 'trusted_proxy' || key === 'skip_email_verification' || key === 'skip_signature_verify') return 'Access and trust';
      if (key === 'base_url' || key === 'cors_origin' || key === 'port' || key === 'ssr_anon_cache_ttl_ms' || key === 'database_path' || key === 'upload_dir' || key === 'og_dir' || key === 'run_jobs_internally' || key === 'og_job_concurrency' || key.startsWith('audit_log_')) return 'Server and platform';
      if (key === 'federation_queue_health_allowed_accounts' || key.startsWith('outbound_') || key.startsWith('inbox_')) return 'Federation and queues';
      if (key.startsWith('smtp_')) return 'Email delivery';
      if (key === 'calendar_feed_token_secret' || key === 'unsplash_access_key') return 'Secrets and integrations';
      return 'Other';
    };

    const query = runtimeSettingsQuery.trim().toLowerCase();

    for (const setting of settings) {
      const group = resolveGroup(setting.key);
      if (query) {
        const haystack = `${group} ${setting.key} ${setting.label} ${setting.description || ''}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      groups.get(group)?.push(setting);
    }

    return groupOrder
      .map((group) => ({ title: group, settings: groups.get(group) ?? [] }))
      .filter((group) => group.settings.length > 0);
  }, [settings, runtimeSettingsQuery]);
  const runtimeScopeLabel = useCallback((scope?: AdminSetting['applyScope']) => {
    if (scope === 'immediate') return 'Applies immediately';
    if (scope === 'next_worker_tick') return 'Applies on next worker run';
    return 'Requires restart';
  }, []);

  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    settings.forEach((setting) => {
      const sourceValue = setting.value ?? setting.effectiveValue;
      nextDrafts[setting.key] = sourceValue == null ? '' : String(sourceValue);
    });
    setRuntimeDraftValues(nextDrafts);
  }, [settings]);

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
    sections.forEach(({ key }) => {
      const el = sectionRefs.current[key];
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
  const getSettingsGroupId = (title: string) => `settings-group-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const scrollToSettingsGroup = (title: string) => {
    const el = document.getElementById(getSettingsGroupId(title));
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  async function adminFetch(path: string, init?: RequestInit) {
    const method = (init?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || {});
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfMatch = document.cookie.match(/(?:^|;\s*)everycal_csrf=([^;]+)/);
      if (csrfMatch?.[1]) headers.set('X-CSRF-Token', csrfMatch[1]);
    }
    const res = await fetch(path, { credentials: 'include', ...init, headers });
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

  const refreshAllData = useCallback(async () => {
    setError(null);
    setIsRefreshingAll(true);
    try {
      await Promise.all([
        refreshHealth(),
        refreshAudit(),
        refreshAccounts(),
        refreshModerationQueue(),
        refreshFederationBlocks(),
        refreshFederationActors(),
        refreshFederationDomains(),
        refreshFederationTombstones(),
        refreshSettings(),
        refreshJobRuns(),
      ]);
      setLastRefreshedAt(new Date());
      setRefreshCountdownSec(60);
    } catch (e) {
      setError(toErrorMessage(e, 'Failed to refresh admin data'));
    } finally {
      setIsRefreshingAll(false);
    }
  }, [
    accountQuery,
    actorQuery,
    actorStatus,
    auditAction,
    auditActor,
    auditTarget,
    blockQuery,
    queueState,
  ]);

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
      setError(toErrorMessage(e, 'Failed to complete admin action'));
    }
  }

  useEffect(() => {
    if (!user?.isAdmin) return;
    refreshAllData().catch(() => {});
  }, [user?.isAdmin, refreshAllData]);

  useEffect(() => {
    if (!user?.isAdmin) return;
    const interval = window.setInterval(() => {
      setRefreshCountdownSec((prev) => {
        if (prev <= 1) {
          refreshAllData().catch(() => {});
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [user?.isAdmin, refreshAllData]);

  if (!user?.isAdmin) return <div className='empty-state mt-3'><h2>Redirecting</h2><p>Admin access is required.</p></div>;
  if (error) return <div className='empty-state mt-3'><h2>Error</h2><p>{error}</p></div>;

  return <div className='settings-layout mt-3'>
    <aside className='settings-sidebar'>
      <nav className='settings-nav' aria-label='Admin sections'>
        {sections.map(({ key, label, icon }) => {
          const isSettings = key === 'settings';
          const isActive = activeSection === key;
          return (
            <div key={key} className='settings-nav-group' style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
              <button
                type='button'
                className={`settings-nav-link ${isActive ? 'active' : ''}`}
                onClick={() => scrollToSection(key)}
              >
                {icon}
                <span>{label}</span>
              </button>
              {isSettings && isActive && (
                <div className='settings-nav-subitems' style={{ paddingLeft: '1.7rem', display: 'flex', flexDirection: 'column', gap: '0.15rem', marginTop: '0.2rem' }}>
                  {runtimeSettingGroups.map((group) => (
                    <button
                      key={group.title}
                      type='button'
                      className='text-xs text-left'
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '0.35rem 0.5rem',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font)',
                        textAlign: 'left',
                        transition: 'color 0.15s, background 0.15s',
                        fontSize: '0.8rem',
                        fontWeight: 500,
                      }}
                      onClick={() => scrollToSettingsGroup(group.title)}
                      onMouseOver={(e) => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseOut={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'none'; }}
                    >
                      {group.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>

    <div className='settings-content'>
      <div className='admin-page-toolbar'>
        <h1 className='settings-page-title'>Admin Console</h1>
        <div className='admin-page-refresh-tools'>
          <button
            type='button'
            className='btn btn-ghost btn-sm admin-page-refresh-btn'
            onClick={() => refreshAllData().catch(() => {})}
            disabled={isRefreshingAll}
            aria-label={isRefreshingAll ? 'Refreshing admin data' : `Refresh all admin data. Auto refresh in ${refreshCountdownSec} seconds`}
          >
            <UpdateIcon />
            {isRefreshingAll ? 'Refreshing...' : 'Refresh all'}
          </button>
          <div className='admin-page-refresh-meta'>
            <span className='admin-page-refresh-counter'><TimerIcon />Refreshes again in {refreshCountdownSec}s</span>
            <span className='admin-page-last-refreshed'>Last refreshed {lastRefreshedLabel}</span>
          </div>
        </div>
      </div>
      {status ? <p className='text-sm' role='status'>{status}</p> : null}
      <section className='settings-section'>
        <div className='settings-card admin-overview-card'>
          <h2 className='settings-section-title mb-1'>Overview</h2>
          <p className='admin-overview-subtitle'>Fast path into moderation, federation, jobs, and platform scale.</p>
          <div className='admin-overview-grid' role='list' aria-label='Admin overview metrics'>
            <button type='button' className='admin-overview-item admin-overview-item--neutral' role='listitem' onClick={() => scrollToSection('events')} aria-label={`Total events: ${typeof health?.events === 'number' ? health.events : 'unknown'}. Open events section`}>
              <span className='admin-overview-icon' aria-hidden='true'><CalendarIcon /></span>
              <p className='admin-overview-label'>Total events</p>
              <p className='admin-overview-value'>{typeof health?.events === 'number' ? health.events : '-'}</p>
            </button>
            <button type='button' className='admin-overview-item admin-overview-item--neutral' role='listitem' onClick={() => scrollToSection('accounts')} aria-label={`Total accounts: ${typeof health?.accounts === 'number' ? health.accounts : 'unknown'}. Open accounts section`}>
              <span className='admin-overview-icon' aria-hidden='true'><UserIcon /></span>
              <p className='admin-overview-label'>Total accounts</p>
              <p className='admin-overview-value'>{typeof health?.accounts === 'number' ? health.accounts : '-'}</p>
            </button>
            <button type='button' className='admin-overview-item admin-overview-item--alert' role='listitem' onClick={() => { setQueueState('flagged'); scrollToSection('events'); }} aria-label={`Flagged events: ${queueFlaggedCount}. Open events section`}>
              <span className='admin-overview-icon' aria-hidden='true'><FlagIcon /></span>
              <p className='admin-overview-label'>Flagged events</p>
              <p className='admin-overview-value'>{queueFlaggedCount}</p>
            </button>
            <button type='button' className='admin-overview-item admin-overview-item--warn' role='listitem' onClick={() => scrollToSection('federation')} aria-label={`Active federation blocks: ${blockedFederationCount}. Open federation section`}>
              <span className='admin-overview-icon' aria-hidden='true'><ShieldIcon /></span>
              <p className='admin-overview-label'>Active federation blocks</p>
              <p className='admin-overview-value'>{blockedFederationCount}</p>
            </button>
            <button type='button' className='admin-overview-item admin-overview-item--warn' role='listitem' onClick={() => scrollToSection('jobs')} aria-label={`Failed or retrying jobs: ${failedOrRetryingJobs}. Open jobs section`}>
              <span className='admin-overview-icon' aria-hidden='true'><CheckCalendarIcon /></span>
              <p className='admin-overview-label'>Failed or retrying jobs</p>
              <p className='admin-overview-value'>{failedOrRetryingJobs}</p>
            </button>
          </div>
          <div className='admin-overview-uptime' role='status' aria-live='polite'>
            <div>
              <p className='admin-overview-label'>Up since</p>
              <p className='admin-overview-uptime-value'>{upSinceLabel}</p>
            </div>
          </div>
        </div>
      </section>

    <section id='accounts' ref={(el) => { sectionRefs.current.accounts = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Accounts</h2>
      <p className='text-sm text-muted mb-1'>Search users, disable compromised accounts, and restore access when resolved.</p>
      <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshAccounts().catch((err) => setError(toErrorMessage(err, 'Failed to refresh accounts'))); }}>
        <input aria-label='Search accounts by username' placeholder='Search username' value={accountQuery} onChange={(e) => setAccountQuery(e.target.value)} />
        <button className='btn btn-primary' type='submit'>Search</button>
      </form>
      <ul className='admin-record-list admin-record-list--accounts' role='list' aria-label='Accounts'>
        {accounts.map((a) => (
          <li key={a.id} className='admin-record-row'>
            <div className='admin-record-main'>
              <p className='admin-record-title'>
                @{a.username}
                {a.is_admin ? <span className='admin-record-pill is-accent'>Admin</span> : null}
              </p>
              <p className='admin-record-subtitle'>{a.id}</p>
            </div>
            <div className='admin-record-meta' aria-label='Account attributes'>
              <span className={`admin-record-pill ${a.is_disabled ? 'is-danger' : 'is-success'}`}>{a.is_disabled ? 'Disabled' : 'Active'}</span>
              {a.is_locked_out ? <span className='admin-record-pill is-danger'>Locked out</span> : null}
            </div>
            <div className='admin-record-actions'>
              <button
                className='btn btn-ghost btn-sm'
                disabled={pendingActionKey === `revoke-auth:${a.id}`}
                onClick={() => {
                  openReasonModal({
                    title: `Revoke auth for @${a.username}`,
                    description: 'This revokes all sessions and API keys for the account.',
                    reasonLabel: 'Revocation reason',
                    actionLabel: 'Revoke auth',
                    actionClassName: 'btn-danger',
                    requireReason: true,
                    onConfirm: async (reason) => {
                      setPendingActionKey(`revoke-auth:${a.id}`);
                      try {
                        const data = await adminFetch(`/api/v1/admin/security/accounts/${encodeURIComponent(a.id)}/revoke-auth`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ reason }),
                        });
                        setStatus(`Revoked auth for @${a.username} (sessions: ${data.revokedSessions}, api keys: ${data.revokedApiKeys})`);
                      } finally {
                        setPendingActionKey(null);
                      }
                      await refreshAudit();
                    },
                  });
                }}
              >Revoke auth</button>
              {a.is_locked_out ? (
                <button
                  className='btn btn-ghost btn-sm'
                  disabled={pendingActionKey === `reset-lockout:${a.username}`}
                  onClick={() => {
                    openReasonModal({
                      title: `Reset lockout for @${a.username}`,
                      description: 'This clears failed login attempts and lock timers for this username.',
                      reasonLabel: 'Reset reason',
                      actionLabel: 'Reset lockout',
                      requireReason: true,
                      onConfirm: async (reason) => {
                        setPendingActionKey(`reset-lockout:${a.username}`);
                        try {
                          await adminFetch(`/api/v1/admin/security/login-lockouts/${encodeURIComponent(a.username)}/reset`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reason }),
                          });
                          setStatus(`Reset lockout state for @${a.username}`);
                        } finally {
                          setPendingActionKey(null);
                        }
                        await refreshAccounts();
                        await refreshAudit();
                      },
                    });
                  }}
                >Reset lockout</button>
              ) : null}
              {a.is_disabled ? (
                <button
                  className='btn btn-ghost btn-sm'
                  disabled={pendingActionKey === `enable:${a.id}`}
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
              ) : (
                <button
                  className='btn btn-danger btn-sm'
                  disabled={pendingActionKey === `disable:${a.id}`}
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
              )}
            </div>
          </li>
        ))}
      </ul>
      {!accounts.length ? <p className='text-sm text-muted'>No accounts found for this query.</p> : null}
      </div>
    </section>

    <section id='events' ref={(el) => { sectionRefs.current.events = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Event moderation</h2>
      <p className='text-sm text-muted mb-1'>Review all moderation requests and decide whether to remove or keep each event.</p>
      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1 gap-1'>
          <h3 className='text-sm'>Moderation requests</h3>
          <span className='text-sm text-muted'>{moderationQueue.length} items</span>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshModerationQueue().catch((err) => setError(toErrorMessage(err, 'Failed to refresh moderation queue'))); }}>
          <select value={queueState} onChange={(e) => setQueueState(e.target.value)}>
            <option value='flagged'>open requests</option>
            <option value='hidden'>decided: removed</option>
            <option value='visible'>decided: kept</option>
          </select>
          <button className='btn btn-primary' type='submit'>Refresh list</button>
        </form>
        <ul className='admin-record-list' role='list' aria-label='Moderation requests'>
          {moderationQueue.map((item) => (
            <li key={item.id} className='admin-record-row'>
              <div className='admin-record-main'>
                <p className='admin-record-title'>{item.title || item.id}</p>
                <div className='admin-record-subtitle'>
                  id: {item.id}
                </div>
                {item.moderation_reason ? (
                  <p className='text-sm text-muted mt-1' style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.6rem', fontStyle: 'italic', margin: '0.5rem 0' }}>
                    <strong>Flagger note:</strong> “{item.moderation_reason}”
                  </p>
                ) : null}
                <div className='text-xs text-muted mt-1' style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  <div>Requested: {formatDateTime(item.created_at)}</div>
                  {item.moderated_at ? <div>Moderated: {formatDateTime(item.moderated_at)}</div> : null}
                </div>
                <a
                  className='text-sm mt-1'
                  href={item.owner_username && item.slug
                    ? `/@${item.owner_username}/${item.slug}`
                    : `/events/${encodeURIComponent(item.id)}`}
                  target='_blank'
                  rel='noreferrer'
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', textDecoration: 'none', color: 'var(--accent)' }}
                >
                  <span>View event details</span>
                  <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'></path><polyline points='15 3 21 3 21 9'></polyline><line x1='10' y1='14' x2='21' y2='3'></line></svg>
                </a>
              </div>
              <div className='admin-record-meta' aria-label='Moderation status'>
                <span className={`admin-record-pill ${
                  item.moderation_state === 'flagged' ? 'is-accent' :
                  item.moderation_state === 'hidden' ? 'is-danger' : 'is-success'
                }`}>
                  {item.moderation_state === 'flagged' ? 'Pending' :
                   item.moderation_state === 'hidden' ? 'Hidden' : 'Visible'}
                </span>
                {item.canceled ? <span className='admin-record-pill is-danger'>Canceled</span> : null}
                {item.created_at && (
                  <span className={`admin-record-pill ${item.moderated_at ? '' : 'is-accent'}`}>
                    {item.moderated_at ? `Resolved in ${formatModerationLatency(item.created_at, item.moderated_at)}` : `Open: ${formatModerationLatency(item.created_at, item.moderated_at)}`}
                  </span>
                )}
              </div>
              <div className='admin-record-actions'>
                {item.moderation_state === 'flagged' ? (
                  <ModerationDecisionActions
                    eventId={item.id}
                    eventTitle={item.title}
                    onResolved={async (state) => {
                      setStatus(`${state === 'hidden' ? 'Removed' : 'Kept'} event ${item.id}`);
                      await refreshModerationQueue();
                      await refreshAudit();
                    }}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {!moderationQueue.length ? <p className='text-sm text-muted'>No moderation requests for this filter.</p> : null}
      </div>
      </div>
    </section>

    <section id='federation' ref={(el) => { sectionRefs.current.federation = el; }} className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Federation blocklist & suppression</h2>
      <p className='text-sm text-muted mb-1'>Manage remote trust, blocks, and content suppression in one place.</p>

      <details className='mb-2' style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem', background: 'var(--bg-raised)' }}>
        <summary style={{ fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}>Proactively block or suppress a custom target...</summary>
        <form className='stack-sm mt-1' onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (!proactiveTarget.trim()) return;
          const target = proactiveTarget.trim();

          if (proactiveType === 'domain' || proactiveType === 'actor') {
            const payload = proactiveType === 'domain' ? { blockType: 'domain', domain: target } : { blockType: 'actor', actorUri: target };
            await adminFetch('/api/v1/admin/federation/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            setStatus(`Blocked ${proactiveType}: ${target}`);
          } else {
            if (!proactiveReason.trim()) {
              setError('A reason is required to tombstone an object');
              return;
            }
            await adminFetch('/api/v1/admin/federation/tombstones', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ objectType: proactiveType, objectId: target, reason: proactiveReason.trim() }),
            });
            setStatus(`Created tombstone for ${proactiveType}:${target}`);
          }

          setProactiveTarget('');
          setProactiveReason('');
          await refreshFederationBlocks();
          await refreshFederationActors();
          await refreshFederationDomains();
          await refreshFederationTombstones();
          await refreshAudit();
        }}>
          <div className='flex gap-1' style={{ flexWrap: 'wrap' }}>
            <select aria-label='Suppression type' value={proactiveType} onChange={(e) => setProactiveType(e.target.value)} style={{ maxWidth: '240px' }}>
              <option value='domain'>Domain block (e.g. example.com)</option>
              <option value='actor'>User block (Actor URI)</option>
              <option value='remote_event'>Event tombstone (Object ID / URI)</option>
              <option value='remote_actor'>User tombstone (Actor URI)</option>
              <option value='activity'>Activity tombstone (Activity URI)</option>
            </select>
            <input required aria-label='Suppression target' placeholder={
              proactiveType === 'domain' ? 'example.org' :
              proactiveType === 'actor' ? 'https://remote.example/users/alice' :
              proactiveType === 'remote_event' ? 'https://remote.example/events/123' :
              'ID or URI'
            } value={proactiveTarget} onChange={(e) => setProactiveTarget(e.target.value)} />
            {(proactiveType !== 'domain' && proactiveType !== 'actor') ? (
              <input required aria-label='Reason for tombstone' placeholder='Required reason for audit trail' value={proactiveReason} onChange={(e) => setProactiveReason(e.target.value)} />
            ) : null}
            <button className='btn btn-danger' type='submit'>Apply Suppression</button>
          </div>
        </form>
      </details>

      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1 gap-1'>
          <h3 className='text-sm'>Active Blocks & Suppressions Registry</h3>
          <span className='text-sm text-muted'>{combinedSuppressed.length} entries</span>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); }}>
          <input placeholder='Search active blocks and suppressed targets' value={blockQuery} onChange={(e) => setBlockQuery(e.target.value)} />
        </form>
        <ul className='admin-record-list' role='list' aria-label='Suppressed targets and blocks'>
          {combinedSuppressed.map((item) => (
            <li key={`${item.type}-${item.id}`} className='admin-record-row'>
              <div className='admin-record-main'>
                <p className='admin-record-title'>{item.target}</p>
                <p className='admin-record-subtitle'>id: {item.id}</p>
                <div className='text-sm text-muted mt-1'>
                  added: {formatDateTime(item.createdAt)} · {item.details}
                </div>
                {item.reason ? (
                  <p className='text-sm text-muted mt-1' style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.6rem', fontStyle: 'italic', margin: '0.5rem 0' }}>
                    <strong>Reason:</strong> “{item.reason}”
                  </p>
                ) : null}
              </div>
              <div className='admin-record-meta'>
                <span className={`admin-record-pill ${item.type === 'tombstone' ? 'is-danger' : 'is-accent'}`}>
                  {item.type === 'tombstone' ? 'Tombstone' : `${item.subType} block`}
                </span>
              </div>
              <div className='admin-record-actions'>
                {item.type === 'block' ? (
                  <button
                    className='btn btn-ghost btn-sm'
                    disabled={!item.isActive || pendingActionKey === `unblock:${item.id}`}
                    onClick={() => {
                      openReasonModal({
                        title: 'Unblock target',
                        description: 'Unblocking does not automatically re-import previously hidden content.',
                        reasonLabel: 'Unblock reason',
                        actionLabel: 'Unblock',
                        requireReason: true,
                        onConfirm: async (reason) => {
                          setPendingActionKey(`unblock:${item.id}`);
                          try {
                            await adminFetch(`/api/v1/admin/federation/blocks/${item.id}/unblock`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ reason }),
                            });
                          } finally {
                            setPendingActionKey(null);
                          }
                          setStatus(`Unblocked block: ${item.target}`);
                          await refreshFederationBlocks();
                          await refreshFederationActors();
                          await refreshFederationDomains();
                          await refreshAudit();
                        },
                      });
                    }}
                  >Remove Block</button>
                ) : (
                  <button
                    className='btn btn-ghost btn-sm'
                    onClick={() => {
                      openReasonModal({
                        title: 'Delete tombstone',
                        description: 'This allows future federation fetch of the object again.',
                        reasonLabel: 'Deletion reason',
                        actionLabel: 'Delete',
                        requireReason: true,
                        onConfirm: async (reason) => {
                          await adminFetch(`/api/v1/admin/federation/tombstones/${item.id}/delete`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reason }),
                          });
                          setStatus(`Deleted tombstone: ${item.target}`);
                          await refreshFederationTombstones();
                          await refreshAudit();
                        },
                      });
                    }}
                  >Delete Tombstone</button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {!combinedSuppressed.length ? <p className='text-sm text-muted'>No active blocks or suppressed targets found.</p> : null}
      </div>

      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1 gap-1'>
          <h3 className='text-sm'>Known Federation Domains</h3>
          <span className='text-sm text-muted'>{federationDomains.length} domains</span>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); }}>
          <input placeholder='Filter known domains' value={domainQuery} onChange={(e) => setDomainQuery(e.target.value)} />
        </form>
        <ul className='admin-record-list' role='list' aria-label='Federation domains'>
          {filteredDomains.slice(0, 50).map((domain) => {
            const activeBlock = federationBlocks.find((b) => b.block_type === 'domain' && b.domain === domain.domain && b.is_active);
            return (
              <li key={domain.domain} className='admin-record-row'>
                <div className='admin-record-main'>
                  <p className='admin-record-title'>{domain.domain}</p>
                  <div className='text-sm text-muted mt-1'>
                    actors: {domain.actor_count} · errors: {domain.error_count} · gone: {domain.gone_count}
                  </div>
                </div>
                <div className='admin-record-meta'>
                  {activeBlock ? (
                    <span className='admin-record-pill is-danger'>Blocked</span>
                  ) : (
                    <span className='admin-record-pill is-success'>Allowed</span>
                  )}
                </div>
                <div className='admin-record-actions'>
                  {activeBlock ? (
                    <button
                      className='btn btn-ghost btn-sm'
                      disabled={pendingActionKey === `unblock:${activeBlock.id}`}
                      onClick={() => {
                        openReasonModal({
                          title: 'Unblock domain',
                          description: `Unblocking ${domain.domain} does not automatically re-import previously hidden content.`,
                          reasonLabel: 'Unblock reason',
                          actionLabel: 'Unblock',
                          requireReason: true,
                          onConfirm: async (reason) => {
                            setPendingActionKey(`unblock:${activeBlock.id}`);
                            try {
                              await adminFetch(`/api/v1/admin/federation/blocks/${activeBlock.id}/unblock`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ reason }),
                              });
                            } finally {
                              setPendingActionKey(null);
                            }
                            setStatus(`Unblocked domain: ${domain.domain}`);
                            await refreshFederationBlocks();
                            await refreshFederationDomains();
                            await refreshAudit();
                          },
                        });
                      }}
                    >Unblock</button>
                  ) : (
                    <button
                      className='btn btn-danger btn-sm'
                      disabled={pendingActionKey === `block:${domain.domain}`}
                      onClick={() => {
                        openReasonModal({
                          title: `Block domain: ${domain.domain}`,
                          description: `This will hide all remote events and stop fetching content from ${domain.domain}.`,
                          reasonLabel: 'Blocking reason (required for audit)',
                          actionLabel: 'Block Domain',
                          actionClassName: 'btn-danger',
                          requireReason: true,
                          onConfirm: async (reason) => {
                            setPendingActionKey(`block:${domain.domain}`);
                            try {
                              await adminFetch('/api/v1/admin/federation/block', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ blockType: 'domain', domain: domain.domain, reason }),
                              });
                            } finally {
                              setPendingActionKey(null);
                            }
                            setStatus(`Blocked domain: ${domain.domain}`);
                            await refreshFederationBlocks();
                            await refreshFederationDomains();
                            await refreshAudit();
                          },
                        });
                      }}
                    >Block</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!filteredDomains.length ? <p className='text-sm text-muted'>No known federation domains found.</p> : null}
      </div>

      <div className='mt-2'>
        <div className='flex justify-between items-center mb-1 gap-1'>
          <h3 className='text-sm'>Known Federation Users (Actors)</h3>
          <span className='text-sm text-muted'>{federationActors.length} users</span>
        </div>
        <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshFederationActors().catch((err) => setError(toErrorMessage(err, 'Failed to refresh federation actors'))); }}>
          <input placeholder='Search URI, domain, or username' value={actorQuery} onChange={(e) => setActorQuery(e.target.value)} />
          <select aria-label='Filter status' value={actorStatus} onChange={(e) => setActorStatus(e.target.value)}>
            <option value=''>all statuses</option>
            <option value='active'>active</option>
            <option value='error'>error</option>
            <option value='gone'>gone</option>
          </select>
          <button className='btn btn-primary' type='submit'>Filter</button>
        </form>
        <ul className='admin-record-list' role='list' aria-label='Remote actor diagnostics'>
          {federationActors.slice(0, 50).map((actor) => {
            const activeBlock = federationBlocks.find((b) => b.block_type === 'actor' && b.actor_uri === actor.uri && b.is_active);
            return (
              <li key={actor.uri} className='admin-record-row'>
                <div className='admin-record-main'>
                  <p className='admin-record-title'>@{actor.preferred_username || 'anonymous'}</p>
                  <p className='admin-record-subtitle'>{actor.uri}</p>
                  <div className='text-sm text-muted mt-1'>
                    domain: {actor.domain} · retry: {actor.next_retry_at || 'n/a'}
                  </div>
                  {actor.last_error ? <div className='text-sm text-muted mt-1'>last error: {actor.last_error}</div> : null}
                </div>
                <div className='admin-record-meta'>
                  {activeBlock ? (
                    <span className='admin-record-pill is-danger'>Blocked</span>
                  ) : (
                    <span className={`admin-record-pill ${actor.fetch_status === 'error' || actor.fetch_status === 'gone' ? 'is-danger' : 'is-success'}`}>{actor.fetch_status || 'active'}</span>
                  )}
                </div>
                <div className='admin-record-actions'>
                  {activeBlock ? (
                    <button
                      className='btn btn-ghost btn-sm'
                      disabled={pendingActionKey === `unblock:${activeBlock.id}`}
                      onClick={() => {
                        openReasonModal({
                          title: 'Unblock user',
                          description: `Unblocking @${actor.preferred_username || 'anonymous'} does not automatically re-import previously hidden content.`,
                          reasonLabel: 'Unblock reason',
                          actionLabel: 'Unblock',
                          requireReason: true,
                          onConfirm: async (reason) => {
                            setPendingActionKey(`unblock:${activeBlock.id}`);
                            try {
                              await adminFetch(`/api/v1/admin/federation/blocks/${activeBlock.id}/unblock`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ reason }),
                              });
                            } finally {
                              setPendingActionKey(null);
                            }
                            setStatus(`Unblocked user: @${actor.preferred_username || 'anonymous'}`);
                            await refreshFederationBlocks();
                            await refreshFederationActors();
                            await refreshAudit();
                          },
                        });
                      }}
                    >Unblock</button>
                  ) : (
                    <button
                      className='btn btn-danger btn-sm'
                      disabled={pendingActionKey === `block:${actor.uri}`}
                      onClick={() => {
                        openReasonModal({
                          title: `Block user: @${actor.preferred_username || 'anonymous'}`,
                          description: `This will hide all remote events and stop fetching content from @${actor.preferred_username || 'anonymous'}.`,
                          reasonLabel: 'Blocking reason (required for audit)',
                          actionLabel: 'Block User',
                          actionClassName: 'btn-danger',
                          requireReason: true,
                          onConfirm: async (reason) => {
                            setPendingActionKey(`block:${actor.uri}`);
                            try {
                              await adminFetch('/api/v1/admin/federation/block', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ blockType: 'actor', actorUri: actor.uri, reason }),
                              });
                            } finally {
                              setPendingActionKey(null);
                            }
                            setStatus(`Blocked user: @${actor.preferred_username || 'anonymous'}`);
                            await refreshFederationBlocks();
                            await refreshFederationActors();
                            await refreshAudit();
                          },
                        });
                      }}
                    >Block</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!federationActors.length ? <p className='text-sm text-muted'>No known federation users found.</p> : null}
      </div>
      </div>
    </section>

    <section id='scrapers' ref={(el) => { sectionRefs.current.scrapers = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1 gap-1' style={{ flexWrap: 'wrap' }}>
        <h2 className='settings-section-title'>Available Scrapers</h2>
        <label className='checkbox-label' style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}>
          <input type='checkbox' checked={scraperDryRun} onChange={(e) => setScraperDryRun(e.target.checked)} />
          <span>Dry run (safety enabled)</span>
        </label>
      </div>
      <p className='text-sm text-muted mb-2'>Trigger live or dry run collections directly. In dry run, scraped events are validated without mutating the database.</p>

      <ul className='admin-record-list' role='list' aria-label='Available scrapers'>
        {AVAILABLE_SCRAPERS.map((scraper) => (
          <li key={scraper.id} className='admin-record-row'>
            <div className='admin-record-main'>
              <p className='admin-record-title'>{scraper.name}</p>
              <p className='admin-record-subtitle'>id: {scraper.id} {scraper.url !== 'N/A' ? `· source: ${scraper.url}` : ''}</p>
              <p className='text-sm text-muted mt-1'>{scraper.description}</p>
            </div>
            <div className='admin-record-meta'>
              <span className={`admin-record-pill ${scraperDryRun ? 'is-accent' : 'is-danger'}`}>
                {scraperDryRun ? 'Dry Ingestion' : 'Live Ingestion'}
              </span>
            </div>
            <div className='admin-record-actions'>
              <button
                type='button'
                className={`btn btn-sm ${scraperDryRun ? 'btn-ghost' : 'btn-danger'}`}
                disabled={pendingActionKey === `scraper:${scraper.id}`}
                onClick={async () => {
                  setPendingActionKey(`scraper:${scraper.id}`);
                  try {
                    const data = await adminFetch('/api/v1/admin/scrapers/trigger', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        scraper: scraper.id === 'all' ? undefined : scraper.id,
                        dryRun: scraperDryRun,
                      }),
                    });
                    setStatus(`Queued scraper run ${data.runId} (${scraperDryRun ? 'dry-run' : 'live'})`);
                    await refreshJobRuns();
                    await refreshAudit();
                  } catch (err) {
                    setError(toErrorMessage(err, 'Failed to trigger scraper'));
                  } finally {
                    setPendingActionKey(null);
                  }
                }}
              >
                {scraper.id === 'all' ? 'Run All' : 'Run Scraper'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      </div>
    </section>

    <section id='jobs' ref={(el) => { sectionRefs.current.jobs = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>Job runs</h2>
      </div>
      <p className='text-sm text-muted mb-1'>Recent execution history for admin-triggered background work.</p>
      <ul className='admin-record-list' role='list' aria-label='Job runs'>
        {jobRuns.map((run) => (
          <li key={run.id} className='admin-record-row'>
            <div className='admin-record-main'>
              <p className='admin-record-title'>{run.job_type}</p>
              <p className='admin-record-subtitle'>{run.id}</p>
              <div className='text-sm text-muted'>created: {run.created_at || 'n/a'}</div>
            </div>
            <div className='admin-record-meta'>
              <span className='admin-record-pill'>{run.status}</span>
            </div>
            <div className='admin-record-actions' />
          </li>
        ))}
      </ul>
      {!jobRuns.length ? <p className='text-sm text-muted'>No admin-triggered jobs yet.</p> : null}
      </div>
    </section>

    <section id='audit' ref={(el) => { sectionRefs.current.audit = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>Audit trail</h2>
      </div>
      <p className='text-sm text-muted mb-1'>Immutable log for sensitive admin actions and moderation decisions.</p>
      <form className='flex gap-1 mb-1 flex-wrap' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshAudit().catch((err) => setError(toErrorMessage(err, 'Failed to refresh audit trail'))); }}>
        <select aria-label='Filter by action type' value={auditAction} onChange={(e) => setAuditAction(e.target.value)} style={{ flex: '1 1 180px', minWidth: '150px' }}>
          <option value=''>All Actions</option>
          <option value='account.disable'>account.disable</option>
          <option value='account.enable'>account.enable</option>
          <option value='security.lockout.reset'>security.lockout.reset</option>
          <option value='security.auth.revoke'>security.auth.revoke</option>
          <option value='federation.block'>federation.block</option>
          <option value='federation.unblock'>federation.unblock</option>
          <option value='federation.tombstone.create'>federation.tombstone.create</option>
          <option value='federation.tombstone.delete'>federation.tombstone.delete</option>
          <option value='scraper.trigger'>scraper.trigger</option>
        </select>
        <input placeholder='Actor account ID' value={auditActor} onChange={(e) => setAuditActor(e.target.value)} style={{ flex: '1 1 200px' }} />
        <input placeholder='Target ID' value={auditTarget} onChange={(e) => setAuditTarget(e.target.value)} style={{ flex: '1 1 200px' }} />
        <button className='btn btn-primary' type='submit'>Apply filters</button>
      </form>
      <ul className='admin-record-list' role='list' aria-label='Audit trail'>
        {audit.slice(0, 100).map((item) => (
          <li key={item.id} className='admin-record-row'>
            <div className='admin-record-main'>
              <p className='admin-record-title'>{item.action_type}</p>
              <p className='admin-record-subtitle'>{item.id}</p>
              <div className='text-sm text-muted'>admin: {item.admin_account_id} · target: {item.target_type}:{item.target_id} · at: {item.created_at}</div>
              <details className='mt-1' style={{ fontSize: '0.8rem', background: 'var(--bg-raised)', padding: '0.45rem 0.65rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                <summary style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--text-muted)', fontWeight: 600 }}>View full audit payload</summary>
                <pre style={{ margin: '0.4rem 0 0', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  {JSON.stringify(JSON.parse(item.payload_json || '{}'), null, 2)}
                </pre>
              </details>
            </div>
            <div className='admin-record-meta'>
              <span className='admin-record-pill'>audit</span>
            </div>
            <div className='admin-record-actions' />
          </li>
        ))}
      </ul>
      {!audit.length ? <p className='text-sm text-muted'>No audit entries match the active filters.</p> : null}
      </div>
    </section>

    <section id='settings' ref={(el) => { sectionRefs.current.settings = el; }} className='settings-section'>
      <div className='settings-card'>
      <div className='flex justify-between items-center mb-1'>
        <h2 className='settings-section-title'>Runtime settings</h2>
      </div>
      <div className='runtime-settings-toolbar'>
        <input
          type='search'
          value={runtimeSettingsQuery}
          onChange={(e) => setRuntimeSettingsQuery(e.target.value)}
          placeholder='Search settings by name, key, category, or description'
          aria-label='Search runtime settings'
        />
      </div>
      <div className='runtime-settings-groups'>
        {runtimeSettingGroups.length === 0 ? (
          <p className='text-sm text-muted'>No settings match your search.</p>
        ) : null}
        {runtimeSettingGroups.map((group) => (
          <div key={group.title} id={getSettingsGroupId(group.title)} className='runtime-settings-group'>
            <h3 className='runtime-settings-group-title'>{group.title}</h3>
            <div className='runtime-settings-list'>
              {group.settings.map((setting) => (
                <div key={setting.key} className='runtime-setting-row'>
                  <div>
                    <strong>{setting.label}</strong>
                    <div className='text-sm text-muted'>
                      {typeof setting.effectiveValue === 'boolean'
                        ? `Current policy: ${setting.effectiveValue ? 'Enabled' : 'Disabled'}`
                        : `Current value: ${String(setting.effectiveValue)}`}
                      {` · ${runtimeScopeLabel(setting.applyScope)}`}
                      {setting.lockedByEnv ? ' · Locked by environment variable' : ''}
                    </div>
                    {setting.description ? <div className='text-sm text-muted'>{setting.description}</div> : null}
                  </div>
                  <div className='flex gap-1'>
                    {typeof setting.effectiveValue === 'boolean' ? (
                      <label className='runtime-toggle'>
                        <input
                          className='runtime-toggle-input'
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
                        <span className='runtime-toggle-track' aria-hidden='true'>
                          <span className='runtime-toggle-thumb' />
                        </span>
                      </label>
                    ) : (
                      <div className='runtime-setting-edit'>
                        <input
                          type={setting.kind === 'secret' ? 'password' : (setting.kind === 'number' ? 'number' : 'text')}
                          value={runtimeDraftValues[setting.key] ?? ''}
                          disabled={!setting.editable || setting.lockedByEnv || pendingActionKey === `setting:${setting.key}`}
                          onChange={(e) => setRuntimeDraftValues((prev) => ({ ...prev, [setting.key]: e.target.value }))}
                          aria-label={`${setting.label} value`}
                        />
                        <button
                          type='button'
                          className='btn btn-primary btn-sm'
                          disabled={!setting.editable || setting.lockedByEnv || pendingActionKey === `setting:${setting.key}`}
                          onClick={() => {
                            const rawValue = (runtimeDraftValues[setting.key] ?? '').trim();
                            let nextValue: string | number;
                            if (setting.kind === 'number') {
                              const parsed = Number(rawValue);
                              if (!Number.isFinite(parsed)) {
                                setError(`Invalid numeric value for ${setting.label}`);
                                return;
                              }
                              nextValue = parsed;
                            } else {
                              nextValue = runtimeDraftValues[setting.key] ?? '';
                            }
                            openReasonModal({
                              title: `Set ${setting.label}`,
                              description: 'Writes DB-backed value. Environment override still takes precedence.',
                              reasonLabel: 'Change reason',
                              actionLabel: 'Save value',
                              requireReason: true,
                              onConfirm: async (reason) => {
                                setPendingActionKey(`setting:${setting.key}`);
                                try {
                                  await adminFetch(`/api/v1/admin/settings/${encodeURIComponent(setting.key)}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ value: nextValue, reason }),
                                  });
                                } finally {
                                  setPendingActionKey(null);
                                }
                                setStatus(`Updated ${setting.label.toLowerCase()}`);
                                await refreshSettings();
                                await refreshAudit();
                              },
                            });
                          }}
                        >Save</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
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
                onClick={() => submitReasonModal().catch((e) => setError(toErrorMessage(e, 'Failed to submit reason')))}
              >{confirmState.loading ? 'Working…' : confirmState.actionLabel}</button>
            </div>
          </div>
        </div>
      </div>
    ) : null}
  </div>;
}
