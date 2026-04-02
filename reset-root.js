#!/usr/bin/env node
/**
 * LockerHub Root Password Reset Script
 *
 * Usage (run on EC2):
 *   node reset-root.js                    # Resets root password to default (adcc@123)
 *   node reset-root.js mynewpassword      # Resets root password to 'mynewpassword'
 *
 * This script bypasses the app entirely — it writes directly to the database.
 * Use it when you're locked out or someone changed the root password.
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'lockerhub.db');
const DEFAULT_PASSWORD = 'adcc@123';

try {
  const db = new Database(DB_PATH);
  const newPassword = process.argv[2] || DEFAULT_PASSWORD;

  if (newPassword.length < 6) {
    console.error('Error: Password must be at least 6 characters');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(newPassword, 10);

  // Check if root exists
  const root = db.prepare("SELECT id FROM users WHERE LOWER(username) = 'root'").get();

  if (root) {
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, root.id);
    console.log(`Root password reset successfully.`);
    console.log(`  Username: root`);
    console.log(`  Password: ${newPassword === DEFAULT_PASSWORD ? DEFAULT_PASSWORD + ' (default)' : '(custom)'}`);
  } else {
    // Root doesn't exist — create it
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, 'root', hash, 'Root Admin', 'headoffice', null
    );
    console.log(`Root account created.`);
    console.log(`  Username: root`);
    console.log(`  Password: ${newPassword === DEFAULT_PASSWORD ? DEFAULT_PASSWORD + ' (default)' : '(custom)'}`);
  }

  db.close();
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
}
