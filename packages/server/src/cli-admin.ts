import { config } from "dotenv";
import { resolve } from "node:path";
import { initDatabase } from "./db.js";
import { getDatabasePath } from "./lib/paths.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });
config({ quiet: true });

const username = process.argv[2];
if (!username) {
  console.error("Usage: pnpm --filter @everycal/server admin:grant <username>");
  process.exit(1);
}
const databasePath = getDatabasePath();
const db = initDatabase(databasePath);
const row = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username) as { id: string } | undefined;
if (!row) {
  console.error(`Account not found: ${username}`);
  process.exit(1);
}
db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(row.id);
console.log(`Granted admin to ${username} in ${databasePath}`);
