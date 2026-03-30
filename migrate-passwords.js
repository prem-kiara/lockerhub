/**
 * LockerHub - Password Migration Script
 * Converts all plaintext passwords to bcrypt hashes.
 * Safe to run multiple times — skips already-hashed passwords.
 *
 * Usage: node migrate-passwords.js
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const BCRYPT_ROUNDS = 10;
const DATA_DIR = path.join(__dirname, 'data');
const db = new Database(path.join(DATA_DIR, 'lockerhub.db'));
db.pragma('journal_mode = WAL');

async function migratePasswords() {
  console.log('\n  LockerHub - Password Migration\n  ==============================\n');

  // 1. Migrate staff user passwords
  const users = db.prepare('SELECT id, username, password FROM users').all();
  let usersMigrated = 0;
  let usersSkipped = 0;

  for (const user of users) {
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
      usersSkipped++;
      continue;
    }
    const hashed = await bcrypt.hash(user.password, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);
    usersMigrated++;
    console.log(`  ✅ User "${user.username}" password hashed`);
  }

  console.log(`\n  Users: ${usersMigrated} migrated, ${usersSkipped} already hashed (${users.length} total)\n`);

  // 2. Migrate customer passwords
  const tenants = db.prepare("SELECT id, name, phone, customer_password FROM tenants WHERE customer_password != ''").all();
  let customersMigrated = 0;
  let customersSkipped = 0;

  // Group by phone to avoid hashing the same password multiple times
  const phoneGroups = {};
  for (const t of tenants) {
    if (!phoneGroups[t.phone]) phoneGroups[t.phone] = [];
    phoneGroups[t.phone].push(t);
  }

  for (const [phone, group] of Object.entries(phoneGroups)) {
    const sample = group[0];
    if (sample.customer_password.startsWith('$2a$') || sample.customer_password.startsWith('$2b$')) {
      customersSkipped += group.length;
      continue;
    }
    const hashed = await bcrypt.hash(sample.customer_password, BCRYPT_ROUNDS);
    const result = db.prepare('UPDATE tenants SET customer_password = ? WHERE phone = ?').run(hashed, phone);
    customersMigrated += result.changes;
    console.log(`  ✅ Customer phone "${phone}" (${group[0].name}) — ${result.changes} record(s) hashed`);
  }

  console.log(`\n  Customers: ${customersMigrated} migrated, ${customersSkipped} already hashed (${tenants.length} total)\n`);

  // 3. Summary
  console.log('  ══════════════════════════════════════');
  console.log(`  Migration complete!`);
  console.log(`  Staff passwords:    ${usersMigrated} updated`);
  console.log(`  Customer passwords: ${customersMigrated} updated`);
  console.log('  ══════════════════════════════════════\n');

  if (usersMigrated === 0 && customersMigrated === 0) {
    console.log('  All passwords were already hashed. No changes needed.\n');
  }

  db.close();
}

migratePasswords().catch(err => {
  console.error('Migration failed:', err.message);
  db.close();
  process.exit(1);
});
