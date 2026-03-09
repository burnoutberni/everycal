import type { DB } from "../db.js";

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function uniqueLocalEventSlug(db: DB, accountId: string, title: string, excludeEventId?: string): string {
  const base = slugify(title) || "event";
  let slug = base;
  let n = 1;
  while (true) {
    const existing = db.prepare(
      `SELECT id FROM events WHERE account_id = ? AND slug = ?${excludeEventId ? " AND id != ?" : ""}`
    ).get(accountId, slug, ...(excludeEventId ? [excludeEventId] : [])) as { id: string } | undefined;
    if (!existing) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

export function uniqueRemoteEventSlug(db: DB, actorUri: string, title: string): string {
  const base = slugify(title) || "event";
  let slug = base;
  let n = 1;
  while (true) {
    const existing = db.prepare("SELECT uri FROM remote_events WHERE actor_uri = ? AND slug = ?").get(actorUri, slug) as
      | { uri: string }
      | undefined;
    if (!existing) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}
