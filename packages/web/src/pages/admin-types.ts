export type AdminHealthResponse = {
  uptimeSec: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  accounts: number;
  events: number;
  openRegistrations: boolean;
  openRegistrationsDb: boolean;
  openRegistrationsEnvOverride: boolean;
};
export type Account = { id: string; username: string; is_admin?: number; is_disabled?: number; is_locked_out?: number; account_type?: string; discoverable?: number; email_verified?: number; created_at?: string; is_bot?: number };
export type AccountsResponse = { items: Account[]; enabledAdminCount?: number };
export type ModerationItem = {
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
  flagger_note?: string | null;
  flagged_at?: string | null;
  moderated_at?: string | null;
  account_id?: string;
  created_by_account_id?: string | null;
  owner_username?: string | null;
  created_by_username?: string | null;
  tags?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type FederationBlock = { id: string; block_type: 'actor' | 'domain'; actor_uri?: string | null; domain?: string | null; reason?: string | null; is_active?: number; created_at?: string };
export type FederationActor = { uri: string; preferred_username?: string | null; domain: string; fetch_status?: string | null; last_fetched_at?: string | null; next_retry_at?: string | null; last_error?: string | null };
export type FederationDomain = { domain: string; actor_count: number; error_count: number; gone_count: number; last_fetched_at?: string | null };
export type FederationTombstone = { id: string; object_type: string; object_id: string; reason?: string | null; created_at?: string; expires_at?: string | null };
export type AdminSetting = { key: string; label: string; description?: string; kind?: 'boolean' | 'string' | 'number' | 'json' | 'secret'; value: boolean | string | number | null; effectiveValue: boolean | string | number | null; envOverride: boolean | string | number | null; lockedByEnv: boolean; editable?: boolean; applyScope?: 'immediate' | 'next_worker_tick' | 'restart_required' };
export type JobRun = { id: string; job_type: string; status: string; payload_json?: string | null; result_json?: string | null; created_at?: string; started_at?: string | null; finished_at?: string | null };
export type AuditItem = { id: string; admin_account_id: string; action_type: string; target_type: string; target_id: string; payload_json: string; created_at: string };
export type ConfirmState = { open: boolean; title: string; description: string; reasonLabel: string; actionLabel: string; actionClassName?: string; requireReason?: boolean; loading?: boolean; reason: string; onConfirm: (reason: string) => Promise<void> };
export type AdminSectionKey = 'settings' | 'accounts' | 'events' | 'federation' | 'scrapers' | 'jobs' | 'audit';

export type AdminAuditResponse = { items: AuditItem[] };
export type AdminModerationResponse = { items: ModerationItem[] };
export type AdminFederationBlocksResponse = { items: FederationBlock[] };
export type AdminFederationActorsResponse = { items: FederationActor[] };
export type AdminFederationDomainsResponse = { items: FederationDomain[] };
export type AdminFederationTombstonesResponse = { items: FederationTombstone[] };
export type AdminSettingsResponse = { items: AdminSetting[] };
export type AdminJobRunsResponse = { items: JobRun[] };
export type AdminScraperTriggerResponse = { runId: string; status: string };
export type AdminRevokeAuthResponse = { revokedSessions: number; revokedApiKeys: number };

export type ScraperInfo = {
  id: string;
  name: string;
  url: string;
  description: string;
};

export const AVAILABLE_SCRAPERS: ScraperInfo[] = [
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

export function formatAuditPayload(payload?: string | null) {
  if (!payload?.trim()) return 'n/a';
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

export function parseJobRunResult(payload?: string | null): Record<string, unknown> | null {
  if (!payload?.trim()) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function formatJobRunResult(payload?: string | null) {
  if (!payload?.trim()) return 'n/a';
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
