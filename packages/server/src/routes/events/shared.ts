import type { DB } from "../../db.js";
import { buildDateRangeFilter } from "../../lib/date-query.js";
import { buildRemoteReadabilityFilter } from "../../lib/remote-readability.js";
import { PaginationParamError } from "../../lib/pagination.js";
import { serializeLocalEvent, serializeRemoteEvent } from "../../lib/event-serializers.js";

// ─── Reusable SQL fragments ─────────────────────────────────────────────────

export const LOCAL_EVENT_SELECT = `
  SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
         GROUP_CONCAT(DISTINCT t.tag) AS tags
  FROM events e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN event_tags t ON t.event_id = e.id`;

export const REMOTE_EVENT_SELECT = `
  SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
         ra.domain, ra.icon_url AS actor_icon_url, ra.fetch_status AS actor_fetch_status
  FROM remote_events re
  LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri`;

// ─── Pure utility functions ─────────────────────────────────────────────────

/** Decode an event ID that may be URL-encoded into a URI. */
export function resolveEventUri(id: string): string {
  if (id.startsWith("http")) return id;
  try {
    const decoded = decodeURIComponent(id);
    if (decoded.startsWith("http")) return decoded;
  } catch { /* not URL-encoded */ }
  return id;
}


/** Check whether a user is allowed to view an event based on its visibility. */
export function canViewEvent(
  db: DB,
  visibility: string,
  ownerId: string,
  currentUser?: { id: string } | null,
): boolean {
  if (visibility === "public" || visibility === "unlisted") return true;
  if (!currentUser) return false;
  if (currentUser.id === ownerId) return true;
  const membership = db
    .prepare(
      `SELECT 1 FROM identity_memberships im
       JOIN accounts a ON a.id = im.identity_account_id
       WHERE im.identity_account_id = ?
         AND a.account_type = 'identity'
         AND im.member_account_id = ?
         AND im.role IN ('editor','owner')`
    )
    .get(ownerId, currentUser.id);
  if (membership) return true;
  if (visibility === "followers_only") {
    return !!db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
      .get(currentUser.id, ownerId);
  }
  return false;
}

type DateRangeColumns = { instantColumn: string; dateColumn: string };

/**
 * Build SQL + params for optional date-range filters across paired columns.
 * `instantColumn` is used for timestamp bounds; `dateColumn` is used for
 * date-only bounds.
 */
export function appendDateRangeFilters(
  columns: DateRangeColumns,
  from?: string,
  to?: string,
): { sql: string; params: unknown[] } {
  return buildDateRangeFilter(columns, from, to);
}

/**
 * Build a LIKE-based tag filter for remote events.
 * Remote tags are stored as a comma-separated string, so exact match + boundary
 * variants are needed to avoid partial matches.
 */
export function buildRemoteTagFilter(tagList: string[]): { sql: string; params: unknown[] } {
  if (tagList.length === 0) return { sql: "", params: [] };
  const escapeLike = (s: string) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const conditions = tagList
    .map(() => `(re.tags = ? OR re.tags LIKE ? OR re.tags LIKE ? OR re.tags LIKE ?)`)
    .join(" OR ");
  const params: unknown[] = [];
  for (const tag of tagList) {
    const escaped = escapeLike(tag);
    params.push(tag, `${escaped},%`, `%,${escaped},%`, `%,${escaped}`);
  }
  return { sql: ` AND (${conditions})`, params };
}

export { buildRemoteReadabilityFilter };

type MergedCursor = { startAtUtc: string; id: string };

export function encodeMergedCursor(value: MergedCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeMergedCursor(raw: string | undefined): MergedCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MergedCursor;
    if (!parsed || typeof parsed.startAtUtc !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function validateMergedCursorParam(raw: string | undefined): void {
  if (raw === undefined) return;
  if (!decodeMergedCursor(raw)) throw new PaginationParamError("cursor must be a valid merged cursor");
}

export function compareMergedOrder(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const compareValue = (left: unknown, right: unknown): number => {
    const lhs = String(left || "");
    const rhs = String(right || "");
    if (lhs === rhs) return 0;
    return lhs < rhs ? -1 : 1;
  };
  const t = compareValue(a.startAtUtc, b.startAtUtc);
  if (t !== 0) return t;
  return compareValue(a.id, b.id);
}

export type MergedFetcher = (after: MergedCursor | null, limit: number) => Record<string, unknown>[];

export function paginateMergedFromFetchers(
  opts: {
    limit: number;
    offset: number;
    cursor?: string;
    fetchChunkSize?: number;
    fetchLocal?: MergedFetcher;
    fetchRemote?: MergedFetcher;
  },
): { page: Record<string, unknown>[]; nextCursor: string | null } {
  if (opts.limit === 0) return { page: [], nextCursor: null };
  const chunkSize = Math.max(1, opts.fetchChunkSize ?? (opts.limit + 1));
  const initialCursor = decodeMergedCursor(opts.cursor);
  const effectiveOffset = initialCursor ? 0 : opts.offset;
  const sourceState = {
    local: {
      fetch: opts.fetchLocal,
      cursor: initialCursor,
      rows: [] as Record<string, unknown>[],
      index: 0,
      exhausted: !opts.fetchLocal,
    },
    remote: {
      fetch: opts.fetchRemote,
      cursor: initialCursor,
      rows: [] as Record<string, unknown>[],
      index: 0,
      exhausted: !opts.fetchRemote,
    },
  };

  const ensureLoaded = (key: "local" | "remote"): void => {
    const state = sourceState[key];
    if (state.exhausted || state.index < state.rows.length || !state.fetch) return;
    const rows = state.fetch(state.cursor, chunkSize);
    if (rows.length === 0) {
      state.exhausted = true;
      return;
    }
    state.rows = rows;
    state.index = 0;
    const last = rows[rows.length - 1];
    state.cursor = { startAtUtc: String(last.startAtUtc || ""), id: String(last.id || "") };
  };

  const selected: Record<string, unknown>[] = [];
  let skipped = 0;
  while (selected.length < opts.limit + 1) {
    ensureLoaded("local");
    ensureLoaded("remote");

    const localCurrent = sourceState.local.rows[sourceState.local.index];
    const remoteCurrent = sourceState.remote.rows[sourceState.remote.index];
    if (!localCurrent && !remoteCurrent) break;

    let next: Record<string, unknown>;
    let source: "local" | "remote";
    if (!remoteCurrent || (localCurrent && compareMergedOrder(localCurrent, remoteCurrent) <= 0)) {
      next = localCurrent;
      source = "local";
    } else {
      next = remoteCurrent;
      source = "remote";
    }
    sourceState[source].index += 1;

    if (skipped < effectiveOffset) {
      skipped += 1;
      continue;
    }
    selected.push(next);
  }

  const page = selected.slice(0, opts.limit);
  const next = selected[opts.limit];
  const last = page[page.length - 1];
  const nextCursor = next
    ? encodeMergedCursor({ startAtUtc: String(last.startAtUtc || ""), id: String(last.id || "") })
    : null;
  return { page, nextCursor };
}

// ─── Response formatters ────────────────────────────────────────────────────

export function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return serializeLocalEvent(row);
}

export function formatRemoteEvent(row: Record<string, unknown>): Record<string, unknown> {
  return serializeRemoteEvent(row);
}
