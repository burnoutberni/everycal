import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getLocale, t } from "../lib/i18n.js";
import { sanitizeHtml, stripHtml, isValidHttpUrl, normalizeHttpUrlInput } from "../lib/security.js";
import { isValidIdentityHandle, normalizeHandle } from "../lib/handles.js";
import { isValidVisibility, type EventVisibility } from "@everycal/core";
import {
  type IdentityRole,
  hasRequiredRole,
  getIdentityMembershipRole,
  resolveIdentityByUsername,
} from "../lib/identities.js";

const VALID_ROLES: IdentityRole[] = ["editor", "admin", "owner"];
const VALID_LOCALES = ["en", "de"] as const;
type AppLocale = (typeof VALID_LOCALES)[number];

function parseRole(value: unknown): IdentityRole | null {
  if (typeof value !== "string") return null;
  if (!VALID_ROLES.includes(value as IdentityRole)) return null;
  return value as IdentityRole;
}

function assertWebsite(value: string): boolean {
  return isValidHttpUrl(value);
}

function normalizeOptionalHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeHttpUrlInput(value);
  return normalized || null;
}

function parsePreferredLanguage(value: unknown): AppLocale | null {
  if (typeof value !== "string") return null;
  return VALID_LOCALES.includes(value as AppLocale) ? (value as AppLocale) : null;
}

function formatIdentity(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    username: row.username,
    accountType: row.account_type,
    role: row.role,
    displayName: row.display_name,
    bio: row.bio,
    website: row.website,
    avatarUrl: row.avatar_url,
    discoverable: !!row.discoverable,
    defaultVisibility: row.default_event_visibility,
    city: row.city,
    cityLat: row.city_lat != null ? Number(row.city_lat) : null,
    cityLng: row.city_lng != null ? Number(row.city_lng) : null,
    preferredLanguage: row.preferred_language || "en",
  };
}

function countOwners(db: DB, identityAccountId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM identity_memberships WHERE identity_account_id = ? AND role = 'owner'")
    .get(identityAccountId) as { count: number };
  return row.count;
}

export function identityRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/", requireAuth(), (c) => {
    const user = c.get("user")!;

    const personal = db
      .prepare(
        `SELECT id, username, account_type, display_name, bio, website, avatar_url, discoverable, default_event_visibility,
                city, city_lat, city_lng, preferred_language,
                'owner' AS role
         FROM accounts
         WHERE id = ?`
      )
      .get(user.id) as Record<string, unknown> | undefined;

    const identityRows = db
      .prepare(
        `SELECT a.id, a.username, a.account_type, a.display_name, a.bio, a.website, a.avatar_url, a.discoverable, a.default_event_visibility,
                a.city, a.city_lat, a.city_lng, a.preferred_language,
                im.role
         FROM identity_memberships im
         JOIN accounts a ON a.id = im.identity_account_id
         WHERE im.member_account_id = ?
           AND a.account_type = 'identity'
         ORDER BY a.username ASC`
      )
      .all(user.id) as Record<string, unknown>[];

    const identities = [personal, ...identityRows].filter(Boolean).map((row) => formatIdentity(row!));
    return c.json({ identities });
  });

  router.post("/", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      username?: string;
      displayName?: string;
      bio?: string;
      website?: string;
      avatarUrl?: string;
      discoverable?: boolean;
      defaultVisibility?: EventVisibility;
      city?: string;
      cityLat?: number;
      cityLng?: number;
      preferredLanguage?: AppLocale;
    }>();

    const username = normalizeHandle(body.username || "");
    if (!username) return c.json({ error: t(getLocale(c), "auth.username_required") }, 400);
    if (!isValidIdentityHandle(username)) {
      return c.json({ error: t(getLocale(c), "auth.username_format") }, 400);
    }

    const existing = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (existing) return c.json({ error: t(getLocale(c), "auth.username_taken") }, 409);

    const normalizedWebsite = normalizeOptionalHttpUrl(body.website);
    const normalizedAvatarUrl = normalizeOptionalHttpUrl(body.avatarUrl);

    if (normalizedWebsite && !assertWebsite(normalizedWebsite)) {
      return c.json({ error: t(getLocale(c), "auth.invalid_website_url") }, 400);
    }
    if (normalizedAvatarUrl && !isValidHttpUrl(normalizedAvatarUrl)) {
      return c.json({ error: t(getLocale(c), "auth.avatar_url_http") }, 400);
    }
    const defaultVisibility = body.defaultVisibility || "public";
    if (!isValidVisibility(defaultVisibility)) {
      return c.json({ error: t(getLocale(c), "events.invalid_visibility") }, 400);
    }
    if (
      (body.city !== undefined || body.cityLat !== undefined || body.cityLng !== undefined)
      && !(body.city !== undefined && body.cityLat != null && body.cityLng != null)
    ) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    if (body.preferredLanguage !== undefined && !parsePreferredLanguage(body.preferredLanguage)) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }

    const creatorDefaults = db
      .prepare("SELECT city, city_lat, city_lng, preferred_language FROM accounts WHERE id = ?")
      .get(user.id) as { city: string | null; city_lat: number | null; city_lng: number | null; preferred_language: string | null } | undefined;

    const city = body.city ?? creatorDefaults?.city ?? "Wien";
    const cityLat = body.cityLat ?? creatorDefaults?.city_lat ?? 48.2082;
    const cityLng = body.cityLng ?? creatorDefaults?.city_lng ?? 16.3738;
    const preferredLanguage = parsePreferredLanguage(body.preferredLanguage)
      || parsePreferredLanguage(creatorDefaults?.preferred_language)
      || "en";

    const id = nanoid(16);
    const displayName = stripHtml(body.displayName || username);
    const bio = body.bio ? sanitizeHtml(body.bio) : null;

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO accounts (
          id, username, account_type, display_name, bio, website, avatar_url, discoverable,
          default_event_visibility, city, city_lat, city_lng, preferred_language, email_verified
        ) VALUES (?, ?, 'identity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        id,
        username,
        displayName,
        bio,
        normalizedWebsite,
        normalizedAvatarUrl,
        body.discoverable ?? true ? 1 : 0,
        defaultVisibility,
        city,
        cityLat,
        cityLng,
        preferredLanguage,
      );

      db.prepare(
        `INSERT INTO identity_memberships (identity_account_id, member_account_id, role)
         VALUES (?, ?, 'owner')`
      ).run(id, user.id);
    });

    tx();

    const row = db
      .prepare(
        `SELECT id, username, account_type, display_name, bio, website, avatar_url, discoverable, default_event_visibility,
                city, city_lat, city_lng, preferred_language,
                'owner' AS role
         FROM accounts
         WHERE id = ?`
      )
      .get(id) as Record<string, unknown>;
    return c.json({ identity: formatIdentity(row) }, 201);
  });

  router.patch("/:username", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const username = normalizeHandle(c.req.param("username"));
    const identity = resolveIdentityByUsername(db, username);
    if (!identity) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const role = getIdentityMembershipRole(db, identity.id, user.id);
    if (!hasRequiredRole(role, "admin")) return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);

    const body = await c.req.json<{
      displayName?: string;
      bio?: string;
      website?: string | null;
      avatarUrl?: string | null;
      discoverable?: boolean;
      defaultVisibility?: EventVisibility;
      city?: string;
      cityLat?: number;
      cityLng?: number;
      preferredLanguage?: AppLocale;
    }>();

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(stripHtml(body.displayName));
    }
    if (body.bio !== undefined) {
      fields.push("bio = ?");
      values.push(body.bio ? sanitizeHtml(body.bio) : null);
    }
    if (body.website !== undefined) {
      const normalizedWebsite = normalizeOptionalHttpUrl(body.website);
      if (normalizedWebsite && !assertWebsite(normalizedWebsite)) {
        return c.json({ error: t(getLocale(c), "auth.invalid_website_url") }, 400);
      }
      fields.push("website = ?");
      values.push(normalizedWebsite);
    }
    if (body.avatarUrl !== undefined) {
      const normalizedAvatarUrl = normalizeOptionalHttpUrl(body.avatarUrl);
      if (normalizedAvatarUrl && !isValidHttpUrl(normalizedAvatarUrl)) {
        return c.json({ error: t(getLocale(c), "auth.avatar_url_http") }, 400);
      }
      fields.push("avatar_url = ?");
      values.push(normalizedAvatarUrl);
    }
    if (body.discoverable !== undefined) {
      fields.push("discoverable = ?");
      values.push(body.discoverable ? 1 : 0);
    }
    if (body.defaultVisibility !== undefined) {
      if (!isValidVisibility(body.defaultVisibility)) {
        return c.json({ error: t(getLocale(c), "events.invalid_visibility") }, 400);
      }
      fields.push("default_event_visibility = ?");
      values.push(body.defaultVisibility);
    }
    if (
      (body.city !== undefined || body.cityLat !== undefined || body.cityLng !== undefined)
      && !(body.city !== undefined && body.cityLat != null && body.cityLng != null)
    ) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    if (body.city !== undefined && body.cityLat != null && body.cityLng != null) {
      fields.push("city = ?");
      values.push(body.city);
      fields.push("city_lat = ?");
      values.push(body.cityLat);
      fields.push("city_lng = ?");
      values.push(body.cityLng);
    }
    if (body.preferredLanguage !== undefined) {
      const preferredLanguage = parsePreferredLanguage(body.preferredLanguage);
      if (!preferredLanguage) {
        return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
      }
      fields.push("preferred_language = ?");
      values.push(preferredLanguage);
    }

    if (fields.length === 0) return c.json({ error: t(getLocale(c), "auth.no_fields_to_update") }, 400);

    fields.push("updated_at = datetime('now')");
    values.push(identity.id);
    db.prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);

    const row = db
      .prepare(
        `SELECT a.id, a.username, a.account_type, a.display_name, a.bio, a.website, a.avatar_url, a.discoverable, a.default_event_visibility,
                a.city, a.city_lat, a.city_lng, a.preferred_language,
                im.role
         FROM accounts a
         JOIN identity_memberships im ON im.identity_account_id = a.id AND im.member_account_id = ?
         WHERE a.id = ?`
      )
      .get(user.id, identity.id) as Record<string, unknown>;
    return c.json({ identity: formatIdentity(row) });
  });

  router.delete("/:username", requireAuth(), (c) => {
    const user = c.get("user")!;
    const username = normalizeHandle(c.req.param("username"));
    const identity = resolveIdentityByUsername(db, username);
    if (!identity) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const role = getIdentityMembershipRole(db, identity.id, user.id);
    if (role !== "owner") return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);

    try {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM remote_follows WHERE account_id = ?").run(identity.id);
        db.prepare("UPDATE events SET created_by_account_id = NULL WHERE created_by_account_id = ?").run(identity.id);
        db.prepare("DELETE FROM events WHERE account_id = ?").run(identity.id);
        db.prepare("DELETE FROM accounts WHERE id = ?").run(identity.id);
      });
      tx();
    } catch {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 409);
    }

    return c.json({ ok: true });
  });

  router.get("/:username/members", requireAuth(), (c) => {
    const user = c.get("user")!;
    const username = normalizeHandle(c.req.param("username"));
    const identity = resolveIdentityByUsername(db, username);
    if (!identity) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const role = getIdentityMembershipRole(db, identity.id, user.id);
    if (!hasRequiredRole(role, "admin")) return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);

    const rows = db
      .prepare(
        `SELECT im.member_account_id, im.role, im.created_at, a.username, a.display_name
         FROM identity_memberships im
         JOIN accounts a ON a.id = im.member_account_id
         WHERE im.identity_account_id = ?
         ORDER BY CASE im.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END DESC, a.username ASC`
      )
      .all(identity.id) as {
      member_account_id: string;
      role: IdentityRole;
      created_at: string;
      username: string;
      display_name: string | null;
    }[];

    return c.json({
      members: rows.map((row) => ({
        memberId: row.member_account_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        createdAt: row.created_at,
      })),
    });
  });

  router.post("/:username/members", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const username = normalizeHandle(c.req.param("username"));
    const identity = resolveIdentityByUsername(db, username);
    if (!identity) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const myRole = getIdentityMembershipRole(db, identity.id, user.id);
    if (!hasRequiredRole(myRole, "admin")) return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);

    const body = await c.req.json<{ memberUsername?: string; role?: IdentityRole }>();
    const memberUsername = normalizeHandle(body.memberUsername || "");
    const nextRole = parseRole(body.role);

    if (!memberUsername || !nextRole) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }

    const member = db
      .prepare("SELECT id, username, display_name FROM accounts WHERE username = ? AND account_type = 'person'")
      .get(memberUsername) as { id: string; username: string; display_name: string | null } | undefined;
    if (!member) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const existing = db
      .prepare("SELECT 1 FROM identity_memberships WHERE identity_account_id = ? AND member_account_id = ?")
      .get(identity.id, member.id);
    if (existing) return c.json({ error: t(getLocale(c), "common.requestFailed") }, 409);

    db.prepare(
      `INSERT INTO identity_memberships (identity_account_id, member_account_id, role)
       VALUES (?, ?, ?)`
    ).run(identity.id, member.id, nextRole);

    return c.json({
      member: {
        memberId: member.id,
        username: member.username,
        displayName: member.display_name,
        role: nextRole,
      },
    }, 201);
  });

  router.patch("/:username/members/:memberId", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const username = normalizeHandle(c.req.param("username"));
    const memberId = c.req.param("memberId");
    const identity = resolveIdentityByUsername(db, username);
    if (!identity) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const myRole = getIdentityMembershipRole(db, identity.id, user.id);
    if (!hasRequiredRole(myRole, "admin")) return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);

    const existing = db
      .prepare(
        `SELECT im.role, a.username, a.display_name
         FROM identity_memberships im
         JOIN accounts a ON a.id = im.member_account_id
         WHERE im.identity_account_id = ? AND im.member_account_id = ?`
      )
      .get(identity.id, memberId) as { role: IdentityRole; username: string; display_name: string | null } | undefined;
    if (!existing) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    if (myRole !== "owner" && existing.role === "owner") {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const body = await c.req.json<{ role?: IdentityRole }>();
    const nextRole = parseRole(body.role);
    if (!nextRole) return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);

    if (existing.role === "owner" && nextRole !== "owner" && countOwners(db, identity.id) <= 1) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }

    db.prepare(
      `UPDATE identity_memberships
       SET role = ?
       WHERE identity_account_id = ? AND member_account_id = ?`
    ).run(nextRole, identity.id, memberId);

    return c.json({
      member: {
        memberId,
        username: existing.username,
        displayName: existing.display_name,
        role: nextRole,
      },
    });
  });

  router.delete("/:username/members/:memberId", requireAuth(), (c) => {
    const user = c.get("user")!;
    const username = normalizeHandle(c.req.param("username"));
    const memberId = c.req.param("memberId");
    const identity = resolveIdentityByUsername(db, username);
    if (!identity) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const myRole = getIdentityMembershipRole(db, identity.id, user.id);
    if (!hasRequiredRole(myRole, "admin")) return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);

    const existing = db
      .prepare("SELECT role FROM identity_memberships WHERE identity_account_id = ? AND member_account_id = ?")
      .get(identity.id, memberId) as { role: IdentityRole } | undefined;
    if (!existing) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    if (myRole !== "owner" && existing.role === "owner") {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }
    if (existing.role === "owner" && countOwners(db, identity.id) <= 1) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }

    db.prepare("DELETE FROM identity_memberships WHERE identity_account_id = ? AND member_account_id = ?").run(identity.id, memberId);
    return c.json({ ok: true });
  });

  return router;
}
