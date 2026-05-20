import { initDatabase } from './db.js';
import { DATABASE_PATH } from './lib/paths.js';

const username = process.argv[2];
if (!username) {
  console.error('Usage: pnpm --filter @everycal/server admin:grant <username>');
  process.exit(1);
}
const db = initDatabase(DATABASE_PATH);
const row = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username) as {id:string}|undefined;
if (!row) {
  console.error(`Account not found: ${username}`);
  process.exit(1);
}
db.prepare('UPDATE accounts SET is_admin = 1 WHERE id = ?').run(row.id);
console.log(`Granted admin to ${username}`);
