import type { DB } from "../db.js";

export type IdentityRole = "editor" | "owner";

export type ActingAccount = {
  id: string;
  username: string;
  displayName: string | null;
  accountType: "person" | "identity";
  role: IdentityRole;
};

const ROLE_RANK: Record<IdentityRole, number> = {
  editor: 1,
  owner: 2,
};

export function hasRequiredRole(role: IdentityRole | null, minRole: IdentityRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function resolveIdentityByUsername(db: DB, username: string): {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  website: string | null;
  avatar_url: string | null;
  discoverable: number;
} | null {
  const row = db
    .prepare(
      `SELECT id, username, display_name, bio, website, avatar_url, discoverable
       FROM accounts
       WHERE username = ? AND account_type = 'identity'`
    )
    .get(username) as
      | {
          id: string;
          username: string;
          display_name: string | null;
          bio: string | null;
          website: string | null;
          avatar_url: string | null;
          discoverable: number;
        }
      | undefined;
  return row || null;
}

export function getIdentityMembershipRole(
  db: DB,
  identityAccountId: string,
  memberAccountId: string
): IdentityRole | null {
  const row = db
    .prepare(
      `SELECT im.role
       FROM identity_memberships im
       JOIN accounts a ON a.id = im.identity_account_id
       WHERE im.identity_account_id = ?
         AND im.member_account_id = ?
         AND a.account_type = 'identity'`
    )
    .get(identityAccountId, memberAccountId) as { role: IdentityRole } | undefined;
  return row?.role || null;
}

export function canManageIdentityEvents(db: DB, accountId: string, userId: string, minRole: IdentityRole): boolean {
  if (accountId === userId) return true;
  const role = getIdentityMembershipRole(db, accountId, userId);
  return hasRequiredRole(role, minRole);
}

export function listActingAccounts(db: DB, userId: string, minRole: IdentityRole = "editor"): ActingAccount[] {
  const self = db
    .prepare(
      `SELECT id, username, display_name, account_type
       FROM accounts
       WHERE id = ?`
    )
    .get(userId) as
      | {
          id: string;
          username: string;
          display_name: string | null;
          account_type: "person" | "identity";
        }
      | undefined;

  const identities = db
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.account_type, im.role
       FROM identity_memberships im
       JOIN accounts a ON a.id = im.identity_account_id
       WHERE im.member_account_id = ?
         AND a.account_type = 'identity'`
    )
    .all(userId) as Array<{
    id: string;
    username: string;
    display_name: string | null;
    account_type: "identity";
    role: IdentityRole;
  }>;

  const result: ActingAccount[] = [];
  if (self) {
    result.push({
      id: self.id,
      username: self.username,
      displayName: self.display_name,
      accountType: self.account_type,
      role: "owner",
    });
  }
  for (const row of identities) {
    if (!hasRequiredRole(row.role, minRole)) continue;
    result.push({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      accountType: row.account_type,
      role: row.role,
    });
  }
  return result;
}
