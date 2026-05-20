import type { DB } from "../db.js";
import { generateKeyPair } from "./crypto.js";

export function ensureKeyPairForAccount(db: DB, accountId: string): { publicKey: string; privateKey: string } | null {
  const row = db
    .prepare("SELECT public_key, private_key FROM accounts WHERE id = ?")
    .get(accountId) as { public_key: string | null; private_key: string | null } | undefined;

  if (!row) return null;

  if (row.public_key && row.private_key) {
    return { publicKey: row.public_key, privateKey: row.private_key };
  }

  const keys = generateKeyPair();
  db.prepare("UPDATE accounts SET public_key = ?, private_key = ? WHERE id = ?").run(
    keys.publicKey,
    keys.privateKey,
    accountId,
  );
  return keys;
}
