const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { generatePdfBuffer } = require('./allotment-form');

const app = express();
const PORT = process.env.PORT || 8080;

// Ensure data directories exist
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const LOG_DIR = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// Database setup
const db = new Database(path.join(DATA_DIR, 'lockerhub.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================
//  LOGGING SYSTEM
// ============================
const APP_LOG = path.join(LOG_DIR, 'app.log');

function writeLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
  fs.appendFileSync(APP_LOG, line);
  if (level === 'error') console.error(line.trim());
}

function logInfo(msg, meta) { writeLog('info', msg, meta); }
function logWarn(msg, meta) { writeLog('warn', msg, meta); }
function logError(msg, meta) { writeLog('error', msg, meta); }

// Rotate log if > 5MB
function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(APP_LOG) && fs.statSync(APP_LOG).size > 5 * 1024 * 1024) {
      const rotated = APP_LOG.replace('.log', `_${Date.now()}.log`);
      fs.renameSync(APP_LOG, rotated);
      logInfo('Log rotated', { old: rotated });
    }
  } catch (e) { /* ignore rotation errors */ }
}
// Check rotation every hour
setInterval(rotateLogIfNeeded, 60 * 60 * 1000);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - start;
    const logEntry = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: duration + 'ms',
      ip: req.ip || req.connection.remoteAddress
    };
    // Skip logging static file requests to keep logs clean
    if (!req.originalUrl.startsWith('/api/')) {
      // Don't log static files
    } else {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      writeLog(level, `${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`, { ip: logEntry.ip });
    }
    originalEnd.apply(res, args);
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================
//  DATABASE SCHEMA
// ============================
db.exec(`
  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'branch',
    branch_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS locker_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    variant TEXT DEFAULT 'Standard',
    lockers_per_unit INTEGER NOT NULL DEFAULT 6,
    unit_height_mm REAL DEFAULT 0,
    unit_width_mm REAL DEFAULT 0,
    unit_depth_mm REAL DEFAULT 0,
    locker_height_mm REAL DEFAULT 0,
    locker_width_mm REAL DEFAULT 0,
    locker_depth_mm REAL DEFAULT 0,
    weight_kg REAL DEFAULT 0,
    auto_size TEXT DEFAULT '',
    description TEXT DEFAULT '',
    is_upcoming INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    locker_type_id TEXT NOT NULL,
    unit_number TEXT NOT NULL,
    location TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (locker_type_id) REFERENCES locker_types(id)
  );

  CREATE TABLE IF NOT EXISTS lockers (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    unit_id TEXT DEFAULT '',
    locker_type_id TEXT DEFAULT '',
    number TEXT NOT NULL,
    size TEXT DEFAULT 'Large',
    location TEXT DEFAULT '',
    rent REAL DEFAULT 0,
    status TEXT DEFAULT 'vacant',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    emergency TEXT DEFAULT '',
    locker_id TEXT DEFAULT '',
    lease_start TEXT DEFAULT '',
    lease_end TEXT DEFAULT '',
    annual_rent REAL DEFAULT 0,
    deposit REAL DEFAULT 0,
    bank_name TEXT DEFAULT '',
    bank_account TEXT DEFAULT '',
    bank_ifsc TEXT DEFAULT '',
    bank_branch TEXT DEFAULT '',
    bg_aadhaar TEXT DEFAULT '',
    bg_pan TEXT DEFAULT '',
    bg_photos_collected INTEGER DEFAULT 0,
    bg_status TEXT DEFAULT 'Pending',
    bg_notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    locker_id TEXT DEFAULT '',
    type TEXT DEFAULT 'rent',
    period TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    due_date TEXT DEFAULT '',
    status TEXT DEFAULT 'Pending',
    paid_on TEXT DEFAULT '',
    method TEXT DEFAULT '',
    ref_no TEXT DEFAULT '',
    receipt_no TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    locker_id TEXT DEFAULT '',
    period TEXT DEFAULT '',
    rate REAL DEFAULT 0,
    principal REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    due_date TEXT DEFAULT '',
    status TEXT DEFAULT 'Pending',
    paid_on TEXT DEFAULT '',
    method TEXT DEFAULT '',
    ref_no TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    locker_id TEXT DEFAULT '',
    requested_date TEXT NOT NULL,
    requested_time TEXT DEFAULT '',
    purpose TEXT DEFAULT 'Locker Access',
    status TEXT DEFAULT 'Pending',
    booked_by TEXT DEFAULT 'customer',
    approved_by TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    admin_notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    locker_id TEXT DEFAULT '',
    datetime TEXT DEFAULT '',
    purpose TEXT DEFAULT '',
    duration TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS config (
    branch_id TEXT PRIMARY KEY,
    rate REAL DEFAULT 8,
    freq TEXT DEFAULT 'monthly',
    calc_on TEXT DEFAULT 'rent_paid',
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );
`);

// ============================
//  DATABASE MIGRATIONS
// ============================
// Add missing columns to existing tables (safe to run multiple times)
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logInfo(`Migration: added column ${column} to ${table}`);
  }
}

// Tenants table migrations
addColumnIfMissing('tenants', 'lease_end', "TEXT DEFAULT ''");
addColumnIfMissing('tenants', 'annual_rent', 'REAL DEFAULT 0');
addColumnIfMissing('tenants', 'deposit', 'REAL DEFAULT 0');

// Payments table migrations
addColumnIfMissing('payments', 'type', "TEXT DEFAULT 'rent'");
addColumnIfMissing('payments', 'period', "TEXT DEFAULT ''");
addColumnIfMissing('payments', 'receipt_no', "TEXT DEFAULT ''");

// Customer portal migrations
addColumnIfMissing('tenants', 'customer_password', "TEXT DEFAULT ''");

// Branches table migrations
addColumnIfMissing('branches', 'location', "TEXT DEFAULT ''");
addColumnIfMissing('branches', 'manager_name', "TEXT DEFAULT ''");

// Locker types table migrations (CHANGE 2)
addColumnIfMissing('locker_types', 'annual_rent', 'REAL DEFAULT 0');
addColumnIfMissing('locker_types', 'deposit', 'REAL DEFAULT 0');

logInfo('Database migrations complete');

// ============================
//  HELPER: Generate ID
// ============================
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ============================
//  AUTH & LOGIN
// ============================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT u.*, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id = b.id WHERE u.username = ?').get(username);
  if (!user || user.password !== password) {
    logWarn('Login failed', { username, ip: req.ip });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  logInfo('Login success', { username, role: user.role, branch: user.branch_name });
  res.json({ id: user.id, name: user.name, role: user.role, branch_id: user.branch_id, branch_name: user.branch_name });
});

// ============================
//  BRANCHES
// ============================
app.get('/api/branches', (req, res) => {
  const branches = db.prepare('SELECT * FROM branches ORDER BY name').all();
  res.json(branches);
});

app.post('/api/branches', (req, res) => {
  const { name, address, phone, location, manager_name } = req.body;
  const id = genId();
  db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, address || '', phone || '', location || '', manager_name || '');
  db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(id);
  logInfo('Branch created', { id, name, location });
  res.json({ id, name });
});

// CHANGE 1: Branch Setup Wizard - Create branch + config + user + units + lockers
app.post('/api/branches/setup', (req, res) => {
  const { name, address, phone, location, manager_name, l6_standard, l10_standard, l6_ultra, l10_ultra } = req.body;

  try {
    const branchId = genId();
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    // 1. Create branch
    db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(
      branchId, name, address || '', phone || '', location || '', manager_name || ''
    );

    // 2. Create config entry
    db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(branchId);

    // 3. Create branch staff user
    const staffUserId = genId();
    const staffUsername = name.toLowerCase().replace(/\s+/g, '');
    const staffPassword = 'admin@123';
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      staffUserId, staffUsername, staffPassword, name + ' Manager', 'branch', branchId
    );

    // Get locker type IDs (assuming standard types exist)
    const l6StdType = db.prepare("SELECT id FROM locker_types WHERE name = 'L6' AND variant = 'Standard' LIMIT 1").get();
    const l10StdType = db.prepare("SELECT id FROM locker_types WHERE name = 'L10' AND variant = 'Standard' LIMIT 1").get();
    const l6UltraType = db.prepare("SELECT id FROM locker_types WHERE name = 'L6' AND variant LIKE '%Ultra%' LIMIT 1").get();
    const l10UltraType = db.prepare("SELECT id FROM locker_types WHERE name = 'L10' AND variant LIKE '%Ultra%' LIMIT 1").get();

    let totalLockers = 0;

    // 4. For each locker type, create units and lockers
    const configs = [
      { count: l6_standard, typeId: l6StdType ? l6StdType.id : null, prefix: 'L6', size: 'Large' },
      { count: l10_standard, typeId: l10StdType ? l10StdType.id : null, prefix: 'L10', size: 'Medium' },
      { count: l6_ultra, typeId: l6UltraType ? l6UltraType.id : null, prefix: 'L6U', size: 'Large' },
      { count: l10_ultra, typeId: l10UltraType ? l10UltraType.id : null, prefix: 'L10U', size: 'Medium' }
    ];

    for (const cfg of configs) {
      if (!cfg.typeId || !cfg.count) continue;

      const typeInfo = db.prepare('SELECT lockers_per_unit FROM locker_types WHERE id = ?').get(cfg.typeId);
      const lockersPerUnit = typeInfo ? typeInfo.lockers_per_unit : 6;

      for (let u = 1; u <= cfg.count; u++) {
        const unitId = genId();
        const unitNumber = `${cfg.prefix}-${u.toString().padStart(2, '0')}`;

        // Create unit
        db.prepare('INSERT INTO units (id, branch_id, locker_type_id, unit_number, location, status) VALUES (?, ?, ?, ?, ?, ?)')
          .run(unitId, branchId, cfg.typeId, unitNumber, '', 'active');

        // Create lockers for this unit
        for (let l = 0; l < lockersPerUnit; l++) {
          const lockerId = genId();
          const lockerNumber = unitNumber + LETTERS[l];
          db.prepare('INSERT INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(lockerId, branchId, unitId, cfg.typeId, lockerNumber, cfg.size, '', 0, 'vacant');
          totalLockers++;
        }
      }
    }

    logInfo('Branch setup complete', { id: branchId, name, totalLockers, staffUser: staffUsername });
    res.json({ id: branchId, name, totalLockers, staffUserId, staffUsername, staffPassword });
  } catch (error) {
    logError('Branch setup failed', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/branches/:id', (req, res) => {
  const { name, address, phone, location, manager_name } = req.body;
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  db.prepare('UPDATE branches SET name = ?, address = ?, phone = ?, location = ?, manager_name = ? WHERE id = ?')
    .run(name || branch.name, address || '', phone || '', location || '', manager_name || '', req.params.id);
  logInfo('Branch updated', { id: req.params.id, name });
  res.json({ success: true });
});

app.delete('/api/branches/:id', (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  // Check for linked data
  const tenantCount = db.prepare('SELECT COUNT(*) as count FROM tenants WHERE branch_id = ?').get(req.params.id).count;
  const lockerCount = db.prepare('SELECT COUNT(*) as count FROM lockers WHERE branch_id = ?').get(req.params.id).count;
  if (tenantCount > 0 || lockerCount > 0) {
    return res.status(400).json({ error: `Cannot delete: branch has ${tenantCount} tenant(s) and ${lockerCount} locker(s)` });
  }
  db.prepare('DELETE FROM config WHERE branch_id = ?').run(req.params.id);
  db.prepare('DELETE FROM branches WHERE id = ?').run(req.params.id);
  logInfo('Branch deleted', { id: req.params.id, name: branch.name });
  res.json({ success: true });
});

// ============================
//  SIZE CLASSIFICATION
// ============================
function classifySize(h, w, d) {
  // Volume in liters (mm³ → liters = /1000000)
  const vol = (h * w * d) / 1000000;
  if (vol <= 50) return 'Small';
  if (vol <= 120) return 'Medium';
  if (vol <= 250) return 'Large';
  return 'XL';
}

// ============================
//  LOCKER TYPES
// ============================
app.get('/api/locker-types', (req, res) => {
  const types = db.prepare('SELECT * FROM locker_types ORDER BY is_upcoming, name, variant').all();
  res.json(types);
});

app.post('/api/locker-types', (req, res) => {
  const d = req.body;
  const id = genId();
  const autoSize = classifySize(d.locker_height_mm || 0, d.locker_width_mm || 0, d.locker_depth_mm || 0);
  db.prepare(`INSERT INTO locker_types (id, name, variant, lockers_per_unit, unit_height_mm, unit_width_mm, unit_depth_mm,
    locker_height_mm, locker_width_mm, locker_depth_mm, weight_kg, auto_size, description, is_upcoming)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, d.name, d.variant || 'Standard', d.lockers_per_unit || 6,
    d.unit_height_mm || 0, d.unit_width_mm || 0, d.unit_depth_mm || 0,
    d.locker_height_mm || 0, d.locker_width_mm || 0, d.locker_depth_mm || 0,
    d.weight_kg || 0, autoSize, d.description || '', d.is_upcoming ? 1 : 0
  );
  res.json({ id, auto_size: autoSize });
});

app.put('/api/locker-types/:id', (req, res) => {
  const d = req.body;
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'id') continue;
    fields.push(`${k} = ?`); vals.push(v);
  }
  // Recalculate auto_size if dimensions changed
  if (d.locker_height_mm || d.locker_width_mm || d.locker_depth_mm) {
    const existing = db.prepare('SELECT * FROM locker_types WHERE id = ?').get(req.params.id);
    const h = d.locker_height_mm || existing.locker_height_mm;
    const w = d.locker_width_mm || existing.locker_width_mm;
    const dp = d.locker_depth_mm || existing.locker_depth_mm;
    fields.push('auto_size = ?'); vals.push(classifySize(h, w, dp));
  }
  if (fields.length) { vals.push(req.params.id); db.prepare(`UPDATE locker_types SET ${fields.join(', ')} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});

app.delete('/api/locker-types/:id', (req, res) => {
  db.prepare('DELETE FROM locker_types WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  UNITS (Physical cabinets)
// ============================
app.get('/api/units', (req, res) => {
  const { branch_id } = req.query;
  let units;
  if (branch_id && branch_id !== 'all') {
    units = db.prepare(`SELECT u.*, lt.name as type_name, lt.variant, lt.lockers_per_unit, lt.auto_size, lt.is_upcoming,
      lt.locker_height_mm, lt.locker_width_mm, lt.locker_depth_mm, lt.unit_height_mm, lt.unit_width_mm, lt.unit_depth_mm, lt.weight_kg,
      b.name as branch_name,
      (SELECT COUNT(*) FROM lockers l WHERE l.unit_id = u.id) as locker_count,
      (SELECT COUNT(*) FROM lockers l WHERE l.unit_id = u.id AND l.status = 'occupied') as occupied_count
      FROM units u
      JOIN locker_types lt ON u.locker_type_id = lt.id
      JOIN branches b ON u.branch_id = b.id
      WHERE u.branch_id = ? ORDER BY u.unit_number`).all(branch_id);
  } else {
    units = db.prepare(`SELECT u.*, lt.name as type_name, lt.variant, lt.lockers_per_unit, lt.auto_size, lt.is_upcoming,
      lt.locker_height_mm, lt.locker_width_mm, lt.locker_depth_mm, lt.unit_height_mm, lt.unit_width_mm, lt.unit_depth_mm, lt.weight_kg,
      b.name as branch_name,
      (SELECT COUNT(*) FROM lockers l WHERE l.unit_id = u.id) as locker_count,
      (SELECT COUNT(*) FROM lockers l WHERE l.unit_id = u.id AND l.status = 'occupied') as occupied_count
      FROM units u
      JOIN locker_types lt ON u.locker_type_id = lt.id
      JOIN branches b ON u.branch_id = b.id
      ORDER BY b.name, u.unit_number`).all();
  }
  res.json(units);
});

// Helper: get next unit number for a given branch + locker type
function getNextUnitNumber(branch_id, locker_type_id) {
  const lt = db.prepare('SELECT name FROM locker_types WHERE id = ?').get(locker_type_id);
  if (!lt) return null;
  const prefix = lt.name; // e.g., "L6" or "L10"
  // Find the highest existing unit number for this prefix in this branch
  const existing = db.prepare(
    `SELECT unit_number FROM units WHERE branch_id = ? AND unit_number LIKE ? ORDER BY unit_number DESC LIMIT 1`
  ).get(branch_id, `${prefix}-%`);
  let nextNum = 1;
  if (existing) {
    const match = existing.unit_number.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) nextNum = parseInt(match[1]) + 1;
  }
  return `${prefix}-${String(nextNum).padStart(2, '0')}`;
}

// Helper: generate next receipt number
function getNextReceiptNo() {
  const last = db.prepare("SELECT receipt_no FROM payments WHERE receipt_no != '' ORDER BY created_at DESC LIMIT 1").get();
  if (!last || !last.receipt_no) return 'RCP-0001';
  const num = parseInt(last.receipt_no.replace('RCP-', '')) || 0;
  return 'RCP-' + String(num + 1).padStart(4, '0');
}

// GET next available unit number
app.get('/api/units/next-number', (req, res) => {
  const { branch_id, locker_type_id } = req.query;
  if (!branch_id || !locker_type_id) return res.status(400).json({ error: 'branch_id and locker_type_id required' });
  const lt = db.prepare('SELECT * FROM locker_types WHERE id = ?').get(locker_type_id);
  if (!lt) return res.status(400).json({ error: 'Invalid locker type' });
  const unitNumber = getNextUnitNumber(branch_id, locker_type_id);
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lockers = [];
  for (let i = 0; i < lt.lockers_per_unit; i++) {
    lockers.push(`${unitNumber}-${ALPHA[i]}`);
  }
  res.json({ unit_number: unitNumber, lockers_per_unit: lt.lockers_per_unit, locker_names: lockers });
});

app.post('/api/units', (req, res) => {
  const { branch_id, locker_type_id, unit_number: providedNumber, location, notes } = req.body;
  const id = genId();
  const lt = db.prepare('SELECT * FROM locker_types WHERE id = ?').get(locker_type_id);
  if (!lt) return res.status(400).json({ error: 'Invalid locker type' });

  // Auto-generate unit number if not provided
  const unit_number = providedNumber || getNextUnitNumber(branch_id, locker_type_id);

  // Create the unit
  db.prepare('INSERT INTO units (id, branch_id, locker_type_id, unit_number, location, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, branch_id, locker_type_id, unit_number, location || '', lt.is_upcoming ? 'upcoming' : 'active', notes || ''
  );

  // Auto-create individual lockers inside this unit (A, B, C, ...)
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const size = lt.auto_size || classifySize(lt.locker_height_mm, lt.locker_width_mm, lt.locker_depth_mm);
  const insertLocker = db.prepare('INSERT INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (let i = 0; i < lt.lockers_per_unit; i++) {
      const lockerNum = `${unit_number}-${ALPHA[i]}`;
      const status = lt.is_upcoming ? 'upcoming' : 'vacant';
      insertLocker.run(genId(), branch_id, id, locker_type_id, lockerNum, size, location || '', 0, status);
    }
  });
  tx();

  res.json({ id, unit_number, lockers_created: lt.lockers_per_unit });
});

app.put('/api/units/:id', (req, res) => {
  const d = req.body;
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries(d)) { if (k === 'id') continue; fields.push(`${k} = ?`); vals.push(v); }
  if (fields.length) { vals.push(req.params.id); db.prepare(`UPDATE units SET ${fields.join(', ')} WHERE id = ?`).run(...vals); }
  // If status changed, update child lockers too
  if (d.status) {
    const lockerStatus = d.status === 'active' ? 'vacant' : d.status;
    db.prepare(`UPDATE lockers SET status = ? WHERE unit_id = ? AND status IN ('upcoming', 'vacant')`).run(lockerStatus, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/units/:id', (req, res) => {
  db.prepare('DELETE FROM lockers WHERE unit_id = ?').run(req.params.id);
  db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  LOCKERS
// ============================
app.get('/api/lockers', (req, res) => {
  const { branch_id } = req.query;
  let lockers;
  if (branch_id && branch_id !== 'all') {
    lockers = db.prepare('SELECT * FROM lockers WHERE branch_id = ? ORDER BY number').all(branch_id);
  } else {
    lockers = db.prepare('SELECT l.*, b.name as branch_name FROM lockers l JOIN branches b ON l.branch_id = b.id ORDER BY b.name, l.number').all();
  }
  res.json(lockers);
});

app.post('/api/lockers', (req, res) => {
  const { branch_id, number, size, location, rent, notes } = req.body;
  const id = genId();
  db.prepare('INSERT INTO lockers (id, branch_id, number, size, location, rent, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, branch_id, number, size || 'Large', location || '', rent || 0, 'vacant', notes || '');
  res.json({ id });
});

app.post('/api/lockers/bulk', (req, res) => {
  const { branch_id, prefix, count, size, rent, location } = req.body;
  const insert = db.prepare('INSERT INTO lockers (id, branch_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const existing = db.prepare('SELECT number FROM lockers WHERE branch_id = ? AND number = ?');
  let added = 0;
  const tx = db.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const num = `${prefix}-${String(i).padStart(3, '0')}`;
      if (!existing.get(branch_id, num)) {
        insert.run(genId(), branch_id, num, size || 'Large', location || '', rent || 0, 'vacant');
        added++;
      }
    }
  });
  tx();
  res.json({ added });
});

app.put('/api/lockers/:id', (req, res) => {
  const { status, notes } = req.body;
  if (status !== undefined) db.prepare('UPDATE lockers SET status = ? WHERE id = ?').run(status, req.params.id);
  if (notes !== undefined) db.prepare('UPDATE lockers SET notes = ? WHERE id = ?').run(notes, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/lockers/:id', (req, res) => {
  db.prepare('DELETE FROM lockers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  TENANTS
// ============================
app.get('/api/tenants', (req, res) => {
  const { branch_id } = req.query;
  let tenants;
  if (branch_id && branch_id !== 'all') {
    tenants = db.prepare(`SELECT t.*, l.number as locker_number FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id WHERE t.branch_id = ? ORDER BY t.name`).all(branch_id);
  } else {
    tenants = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id JOIN branches b ON t.branch_id = b.id ORDER BY b.name, t.name`).all();
  }
  res.json(tenants);
});

app.post('/api/tenants', (req, res) => {
  try {
    const d = req.body;
    const id = genId();
    // Auto-calculate lease_end (365 days from lease_start)
    let lease_end = d.lease_end || '';
    if (!lease_end && d.lease_start) {
      const start = new Date(d.lease_start);
      start.setFullYear(start.getFullYear() + 1);
      lease_end = start.toISOString().split('T')[0];
    }
    db.prepare(`INSERT INTO tenants (id, branch_id, name, phone, email, address, emergency, locker_id, lease_start, lease_end,
      annual_rent, deposit, bank_name, bank_account, bank_ifsc, bank_branch,
      bg_aadhaar, bg_pan, bg_photos_collected, bg_status, bg_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, d.branch_id, d.name, d.phone || '', d.email || '', d.address || '', d.emergency || '', d.locker_id || '', d.lease_start || '', lease_end,
      d.annual_rent || 0, d.deposit || 0, d.bank_name || '', d.bank_account || '', d.bank_ifsc || '', d.bank_branch || '',
      d.bg_aadhaar || '', d.bg_pan || '', d.bg_photos_collected ? 1 : 0, d.bg_status || 'Pending', d.bg_notes || ''
    );
    // Mark locker as occupied
    if (d.locker_id) db.prepare('UPDATE lockers SET status = ? WHERE id = ?').run('occupied', d.locker_id);

    // Auto-generate pending deposit payment if deposit > 0
    if (d.deposit && parseFloat(d.deposit) > 0) {
      const depId = genId();
      const depReceipt = getNextReceiptNo();
      db.prepare('INSERT INTO payments (id, branch_id, tenant_id, locker_id, type, period, amount, due_date, status, paid_on, method, ref_no, receipt_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        depId, d.branch_id, id, d.locker_id || '', 'deposit', '', parseFloat(d.deposit), d.lease_start || new Date().toISOString().split('T')[0], 'Pending', '', '', '', depReceipt, 'Auto-generated on tenant creation'
      );
      logInfo('Auto-created deposit payment', { paymentId: depId, tenantId: id, amount: d.deposit });
    }

    // Auto-generate pending annual rent payment if annual_rent > 0
    if (d.annual_rent && parseFloat(d.annual_rent) > 0) {
      const rentId = genId();
      const rentReceipt = getNextReceiptNo();
      const startDate = d.lease_start || new Date().toISOString().split('T')[0];
      // Calculate period as FY year
      const startDt = new Date(startDate);
      const fy = startDt.getMonth() >= 3 ? startDt.getFullYear() : startDt.getFullYear() - 1;
      const period = `FY ${fy}-${String(fy + 1).slice(2)}`;
      db.prepare('INSERT INTO payments (id, branch_id, tenant_id, locker_id, type, period, amount, due_date, status, paid_on, method, ref_no, receipt_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        rentId, d.branch_id, id, d.locker_id || '', 'rent', period, parseFloat(d.annual_rent), startDate, 'Pending', '', '', '', rentReceipt, 'Auto-generated on tenant creation'
      );
      logInfo('Auto-created rent payment', { paymentId: rentId, tenantId: id, amount: d.annual_rent, period });
    }

    logInfo('Tenant created', { id, name: d.name, locker: d.locker_id, branch: d.branch_id, deposit: d.deposit, annual_rent: d.annual_rent });
    res.json({ id, lease_end, annual_rent: d.annual_rent || 0, deposit: d.deposit || 0 });
  } catch (err) {
    logError('Error creating tenant', { error: err.message, name: req.body.name });
    res.status(500).json({ error: err.message });
  }
});

// Lookup tenant by phone (for staff booking) — MUST be before /:id route
app.get('/api/tenants/by-phone/:phone', (req, res) => {
  const tenant = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name
    FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
    LEFT JOIN branches b ON t.branch_id = b.id
    WHERE t.phone = ?`).get(req.params.phone);
  if (!tenant) return res.status(404).json({ error: 'No tenant found with this phone number' });
  res.json(tenant);
});

app.get('/api/tenants/:id', (req, res) => {
  const tenant = db.prepare(`SELECT t.*, l.number as locker_number FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id WHERE t.id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json(tenant);
});

app.put('/api/tenants/:id', (req, res) => {
  const d = req.body;
  // Handle locker status changes
  const oldTenant = db.prepare('SELECT locker_id FROM tenants WHERE id = ?').get(req.params.id);
  const oldLockerId = oldTenant ? oldTenant.locker_id : '';
  const newLockerId = d.locker_id || '';

  if (oldLockerId !== newLockerId) {
    // Free old locker
    if (oldLockerId) db.prepare("UPDATE lockers SET status = 'vacant' WHERE id = ?").run(oldLockerId);
    // Occupy new locker
    if (newLockerId) db.prepare("UPDATE lockers SET status = 'occupied' WHERE id = ?").run(newLockerId);
    logInfo('Locker reassigned', { tenant: req.params.id, from: oldLockerId, to: newLockerId });
  }

  const fields = [];
  const vals = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'id' || k === 'branch_id') continue;
    fields.push(`${k} = ?`);
    vals.push(v);
  }
  if (fields.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  res.json({ ok: true });
});

app.delete('/api/tenants/:id', (req, res) => {
  const tenant = db.prepare('SELECT locker_id, name FROM tenants WHERE id = ?').get(req.params.id);
  if (tenant && tenant.locker_id) {
    db.prepare("UPDATE lockers SET status = 'vacant' WHERE id = ?").run(tenant.locker_id);
  }
  // Clean up related records
  const delPayments = db.prepare('DELETE FROM payments WHERE tenant_id = ?').run(req.params.id);
  const delPayouts = db.prepare('DELETE FROM payouts WHERE tenant_id = ?').run(req.params.id);
  const delVisits = db.prepare('DELETE FROM visits WHERE tenant_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);
  logWarn('Tenant deleted', { id: req.params.id, name: tenant ? tenant.name : '', payments_removed: delPayments.changes, payouts_removed: delPayouts.changes, visits_removed: delVisits.changes });
  res.json({ ok: true });
});

// ============================
//  STATEMENT OF ACCOUNT (SOA)
// ============================
app.get('/api/soa/:id', (req, res) => {
  try {
    const tenant = db.prepare(`
      SELECT t.*, l.number as locker_number
      FROM tenants t
      LEFT JOIN lockers l ON t.locker_id = l.id
      WHERE t.id = ?
    `).get(req.params.id);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const payments = db.prepare(`
      SELECT * FROM payments WHERE tenant_id = ? ORDER BY COALESCE(paid_on, due_date, created_at) ASC
    `).all(req.params.id);

    const payouts = db.prepare(`
      SELECT * FROM payouts WHERE tenant_id = ? ORDER BY COALESCE(paid_on, due_date, created_at) ASC
    `).all(req.params.id);

    res.json({ tenant, payments, payouts });
  } catch (err) {
    console.error('SOA error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================
//  ALLOTMENT FORM PDF
// ============================
app.get('/api/allotment-form/:id', async (req, res) => {
  try {
    const tenant = db.prepare(`
      SELECT t.*, l.number as locker_number, l.size as locker_size
      FROM tenants t
      LEFT JOIN lockers l ON t.locker_id = l.id
      WHERE t.id = ?
    `).get(req.params.id);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(tenant.branch_id);
    const locker = tenant.locker_id ? db.prepare('SELECT * FROM lockers WHERE id = ?').get(tenant.locker_id) : {};

    const pdfBuffer = await generatePdfBuffer(tenant, branch || {}, locker || {});

    const safeName = (tenant.name || 'tenant').replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Allotment_Form_${safeName}.pdf`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Allotment form error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================
//  PAYMENTS
// ============================
app.get('/api/payments', (req, res) => {
  const { branch_id } = req.query;
  let payments;
  if (branch_id && branch_id !== 'all') {
    payments = db.prepare(`SELECT p.*, t.name as tenant_name, l.number as locker_number
      FROM payments p LEFT JOIN tenants t ON p.tenant_id = t.id LEFT JOIN lockers l ON p.locker_id = l.id
      WHERE p.branch_id = ? ORDER BY p.created_at DESC`).all(branch_id);
  } else {
    payments = db.prepare(`SELECT p.*, t.name as tenant_name, l.number as locker_number, b.name as branch_name
      FROM payments p LEFT JOIN tenants t ON p.tenant_id = t.id LEFT JOIN lockers l ON p.locker_id = l.id
      JOIN branches b ON p.branch_id = b.id ORDER BY p.created_at DESC`).all();
  }
  res.json(payments);
});

app.get('/api/payments/:id', (req, res) => {
  const payment = db.prepare(`SELECT p.*, t.name as tenant_name, l.number as locker_number
    FROM payments p LEFT JOIN tenants t ON p.tenant_id = t.id LEFT JOIN lockers l ON p.locker_id = l.id
    WHERE p.id = ?`).get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  res.json(payment);
});

app.post('/api/payments', (req, res) => {
  const d = req.body;
  const id = genId();
  const receipt_no = d.receipt_no || getNextReceiptNo();
  // Auto-fill locker_id from tenant if not provided
  let locker_id = d.locker_id || '';
  if (!locker_id && d.tenant_id) {
    const tenant = db.prepare('SELECT locker_id FROM tenants WHERE id = ?').get(d.tenant_id);
    if (tenant) locker_id = tenant.locker_id || '';
  }
  db.prepare('INSERT INTO payments (id, branch_id, tenant_id, locker_id, type, period, amount, due_date, status, paid_on, method, ref_no, receipt_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, d.branch_id, d.tenant_id, locker_id, d.type || 'rent', d.period || '', d.amount || 0, d.due_date || '', d.status || 'Pending', d.paid_on || '', d.method || '', d.ref_no || '', receipt_no, d.notes || ''
  );
  logInfo('Payment recorded', { id, receipt_no, type: d.type || 'rent', tenant: d.tenant_id, amount: d.amount, period: d.period, status: d.status });
  res.json({ id, receipt_no });
});

app.put('/api/payments/:id', (req, res) => {
  const d = req.body;
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries(d)) { if (k === 'id' || k === 'branch_id') continue; fields.push(`${k} = ?`); vals.push(v); }
  if (fields.length) { vals.push(req.params.id); db.prepare(`UPDATE payments SET ${fields.join(', ')} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});

app.delete('/api/payments/:id', (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  logWarn('Payment deleted', { id: req.params.id, receipt: payment ? payment.receipt_no : '', amount: payment ? payment.amount : 0 });
  res.json({ ok: true });
});

// ============================
//  RENT SCHEDULE GENERATION
// Mark overdue payments automatically (annual rent: overdue if due_date passed)
app.post('/api/payments/check-overdue', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = db.prepare("UPDATE payments SET status = 'Overdue' WHERE status = 'Pending' AND due_date != '' AND due_date < ?").run(today);
    logInfo('Overdue check completed', { marked: result.changes });
    res.json({ marked_overdue: result.changes });
  } catch (err) {
    logError('Error checking overdue', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================
//  RENEWAL REMINDERS
// ============================
app.get('/api/renewals', (req, res) => {
  try {
    const { branch_id } = req.query;
    const today = new Date().toISOString().split('T')[0];
    // Get tenants whose lease_end is within 30 days or already past
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const future30 = futureDate.toISOString().split('T')[0];

    let query, params;
    if (branch_id && branch_id !== 'all') {
      query = `SELECT t.*, l.number as locker_number FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
        WHERE t.branch_id = ? AND t.lease_end != '' AND t.lease_end <= ? ORDER BY t.lease_end ASC`;
      params = [branch_id, future30];
    } else {
      query = `SELECT t.*, l.number as locker_number, b.name as branch_name FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
        JOIN branches b ON t.branch_id = b.id
        WHERE t.lease_end != '' AND t.lease_end <= ? ORDER BY t.lease_end ASC`;
      params = [future30];
    }

    const tenants = db.prepare(query).all(...params);
    const renewals = tenants.map(t => {
      const leaseEnd = new Date(t.lease_end);
      const todayDate = new Date(today);
      const daysLeft = Math.ceil((leaseEnd - todayDate) / (1000 * 60 * 60 * 24));
      return { ...t, days_left: daysLeft, is_expired: daysLeft < 0 };
    });

    res.json(renewals);
  } catch (err) {
    logError('Renewals error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Renew a tenant's lease (extend by 1 year)
app.post('/api/renewals/:id/renew', (req, res) => {
  try {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const oldEnd = tenant.lease_end || tenant.lease_start;
    const newStart = oldEnd; // New lease starts where old one ended
    const newEndDate = new Date(newStart);
    newEndDate.setFullYear(newEndDate.getFullYear() + 1);
    const newEnd = newEndDate.toISOString().split('T')[0];

    db.prepare('UPDATE tenants SET lease_start = ?, lease_end = ? WHERE id = ?').run(newStart, newEnd, req.params.id);

    // Auto-create pending rent payment for the new lease period
    let rentPaymentCreated = false;
    if (tenant.annual_rent && parseFloat(tenant.annual_rent) > 0) {
      const rentId = genId();
      const rentReceipt = getNextReceiptNo();
      const startDt = new Date(newStart);
      const fy = startDt.getMonth() >= 3 ? startDt.getFullYear() : startDt.getFullYear() - 1;
      const period = `FY ${fy}-${String(fy + 1).slice(2)}`;
      db.prepare('INSERT INTO payments (id, branch_id, tenant_id, locker_id, type, period, amount, due_date, status, paid_on, method, ref_no, receipt_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        rentId, tenant.branch_id, req.params.id, tenant.locker_id || '', 'rent', period, parseFloat(tenant.annual_rent), newStart, 'Pending', '', '', '', rentReceipt, 'Auto-generated on lease renewal'
      );
      logInfo('Auto-created renewal rent payment', { paymentId: rentId, tenantId: req.params.id, amount: tenant.annual_rent, period });
      rentPaymentCreated = true;
    }

    logInfo('Lease renewed', { tenant: req.params.id, name: tenant.name, new_start: newStart, new_end: newEnd });
    res.json({ ok: true, new_start: newStart, new_end: newEnd, rent_payment_created: rentPaymentCreated });
  } catch (err) {
    logError('Renewal error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================
//  PAYOUTS (INTEREST)
// ============================
app.get('/api/payouts', (req, res) => {
  const { branch_id } = req.query;
  let payouts;
  if (branch_id && branch_id !== 'all') {
    payouts = db.prepare(`SELECT p.*, t.name as tenant_name, l.number as locker_number
      FROM payouts p LEFT JOIN tenants t ON p.tenant_id = t.id LEFT JOIN lockers l ON p.locker_id = l.id
      WHERE p.branch_id = ? ORDER BY p.created_at DESC`).all(branch_id);
  } else {
    payouts = db.prepare(`SELECT p.*, t.name as tenant_name, l.number as locker_number, b.name as branch_name
      FROM payouts p LEFT JOIN tenants t ON p.tenant_id = t.id LEFT JOIN lockers l ON p.locker_id = l.id
      JOIN branches b ON p.branch_id = b.id ORDER BY p.created_at DESC`).all();
  }
  res.json(payouts);
});

app.post('/api/payouts', (req, res) => {
  const d = req.body;
  const id = genId();
  db.prepare('INSERT INTO payouts (id, branch_id, tenant_id, locker_id, period, rate, principal, amount, due_date, status, paid_on, method, ref_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, d.branch_id, d.tenant_id, d.locker_id || '', d.period || '', d.rate || 0, d.principal || 0, d.amount || 0, d.due_date || '', d.status || 'Pending', d.paid_on || '', d.method || '', d.ref_no || '', d.notes || ''
  );
  res.json({ id });
});

app.put('/api/payouts/:id', (req, res) => {
  const d = req.body;
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries(d)) { if (k === 'id' || k === 'branch_id') continue; fields.push(`${k} = ?`); vals.push(v); }
  if (fields.length) { vals.push(req.params.id); db.prepare(`UPDATE payouts SET ${fields.join(', ')} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});

// ============================
//  VISITS
// ============================
app.get('/api/visits', (req, res) => {
  const { branch_id } = req.query;
  let visits;
  if (branch_id && branch_id !== 'all') {
    visits = db.prepare(`SELECT v.*, t.name as tenant_name, l.number as locker_number
      FROM visits v LEFT JOIN tenants t ON v.tenant_id = t.id LEFT JOIN lockers l ON v.locker_id = l.id
      WHERE v.branch_id = ? ORDER BY v.datetime DESC`).all(branch_id);
  } else {
    visits = db.prepare(`SELECT v.*, t.name as tenant_name, l.number as locker_number, b.name as branch_name
      FROM visits v LEFT JOIN tenants t ON v.tenant_id = t.id LEFT JOIN lockers l ON v.locker_id = l.id
      JOIN branches b ON v.branch_id = b.id ORDER BY v.datetime DESC`).all();
  }
  res.json(visits);
});

app.post('/api/visits', (req, res) => {
  const d = req.body;
  const id = genId();
  db.prepare('INSERT INTO visits (id, branch_id, tenant_id, locker_id, datetime, purpose, duration, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, d.branch_id, d.tenant_id, d.locker_id || '', d.datetime || '', d.purpose || '', d.duration || '', d.notes || ''
  );
  res.json({ id });
});

// ============================
//  ACTIVITY LOG
// ============================
app.get('/api/activities', (req, res) => {
  const { branch_id } = req.query;
  let activities;
  if (branch_id && branch_id !== 'all') {
    activities = db.prepare('SELECT a.*, b.name as branch_name FROM activities a JOIN branches b ON a.branch_id = b.id WHERE a.branch_id = ? ORDER BY a.created_at DESC LIMIT 50').all(branch_id);
  } else {
    activities = db.prepare('SELECT a.*, b.name as branch_name FROM activities a JOIN branches b ON a.branch_id = b.id ORDER BY a.created_at DESC LIMIT 100').all();
  }
  res.json(activities);
});

app.post('/api/activities', (req, res) => {
  const { branch_id, message } = req.body;
  db.prepare('INSERT INTO activities (branch_id, message) VALUES (?, ?)').run(branch_id, message);
  res.json({ ok: true });
});

// ============================
//  CONFIG
// ============================
app.get('/api/config/:branch_id', (req, res) => {
  let config = db.prepare('SELECT * FROM config WHERE branch_id = ?').get(req.params.branch_id);
  if (!config) config = { rate: 8, freq: 'monthly', calc_on: 'rent_paid' };
  res.json(config);
});

app.put('/api/config/:branch_id', (req, res) => {
  const { rate, freq, calc_on } = req.body;
  const exists = db.prepare('SELECT 1 FROM config WHERE branch_id = ?').get(req.params.branch_id);
  if (exists) {
    db.prepare('UPDATE config SET rate = ?, freq = ?, calc_on = ? WHERE branch_id = ?').run(rate, freq, calc_on, req.params.branch_id);
  } else {
    db.prepare('INSERT INTO config (branch_id, rate, freq, calc_on) VALUES (?, ?, ?, ?)').run(req.params.branch_id, rate, freq, calc_on);
  }
  res.json({ ok: true });
});

// ============================
//  SINGLE BRANCH STATS
// ============================
app.get('/api/stats', (req, res) => {
  const { branch_id } = req.query;
  if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
  const lockers = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='occupied' THEN 1 ELSE 0 END) as occupied, SUM(CASE WHEN status='vacant' THEN 1 ELSE 0 END) as vacant FROM lockers WHERE branch_id = ?`).get(branch_id);
  const revenue = db.prepare(`SELECT COALESCE(SUM(annual_rent), 0) as total FROM tenants WHERE branch_id = ? AND locker_id != ''`).get(branch_id);
  const tenantCount = db.prepare(`SELECT COUNT(*) as total FROM tenants WHERE branch_id = ?`).get(branch_id);
  const overdue = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Overdue'`).get(branch_id);
  const missedPayouts = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payouts WHERE branch_id = ? AND status = 'Missed'`).get(branch_id);
  const collected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid'`).get(branch_id);
  const todayVisits = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE branch_id = ? AND date(datetime) = date('now')`).get(branch_id);
  const unverified = db.prepare(`SELECT COUNT(*) as count FROM tenants WHERE branch_id = ? AND bg_status != 'Verified' AND bg_status != 'verified'`).get(branch_id);
  const pendingInterest = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payouts WHERE branch_id = ? AND (status = 'Pending' OR status = 'Missed')`).get(branch_id);

  // Current month rent summary
  const now = new Date();
  const currentMonth = now.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const monthPaid = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND period = ?`).get(branch_id, currentMonth);
  const monthPending = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Pending' AND period = ?`).get(branch_id, currentMonth);
  const monthOverdue = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Overdue' AND period = ?`).get(branch_id, currentMonth);

  res.json({
    total_lockers: lockers.total || 0, occupied: lockers.occupied || 0, vacant: lockers.vacant || 0,
    occupancy_pct: lockers.total ? Math.round((lockers.occupied || 0) / lockers.total * 100) : 0,
    annual_revenue: revenue.total, monthly_revenue: Math.round(revenue.total / 12),
    tenants: tenantCount.total,
    overdue_count: overdue.count, overdue_amount: overdue.total,
    missed_payouts: missedPayouts.count, missed_payout_amount: missedPayouts.total,
    collected: collected.total, today_visits: todayVisits.count,
    unverified_tenants: unverified.count,
    pending_interest: pendingInterest.total,
    current_month: currentMonth,
    month_paid: monthPaid.count, month_paid_amount: monthPaid.total,
    month_pending: monthPending.count, month_pending_amount: monthPending.total,
    month_overdue: monthOverdue.count, month_overdue_amount: monthOverdue.total
  });
});

// ============================
//  HEAD OFFICE: AGGREGATED STATS
// ============================
app.get('/api/stats/all', (req, res) => {
  const branches = db.prepare('SELECT * FROM branches ORDER BY name').all();
  const stats = branches.map(b => {
    const lockers = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='occupied' THEN 1 ELSE 0 END) as occupied, SUM(CASE WHEN status='vacant' THEN 1 ELSE 0 END) as vacant FROM lockers WHERE branch_id = ?`).get(b.id);
    const revenue = db.prepare(`SELECT COALESCE(SUM(annual_rent), 0) as total FROM tenants WHERE branch_id = ? AND locker_id != ''`).get(b.id);
    const tenants = db.prepare(`SELECT COUNT(*) as total FROM tenants WHERE branch_id = ?`).get(b.id);
    const overdue = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Overdue'`).get(b.id);
    const missedPayouts = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payouts WHERE branch_id = ? AND status = 'Missed'`).get(b.id);
    const collected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid'`).get(b.id);
    const todayVisits = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE branch_id = ? AND date(datetime) = date('now')`).get(b.id);
    const unverified = db.prepare(`SELECT COUNT(*) as count FROM tenants WHERE branch_id = ? AND bg_status != 'Verified' AND bg_status != 'verified'`).get(b.id);

    return {
      branch_id: b.id, branch_name: b.name,
      total_lockers: lockers.total || 0, occupied: lockers.occupied || 0, vacant: lockers.vacant || 0,
      occupancy: lockers.total ? Math.round((lockers.occupied || 0) / lockers.total * 100) : 0,
      occupancy_pct: lockers.total ? Math.round((lockers.occupied || 0) / lockers.total * 100) : 0,
      annual_revenue: revenue.total, tenants: tenants.total,
      overdue_count: overdue.count, overdue_amount: overdue.total,
      missed_payouts: missedPayouts.count, missed_payout_amount: missedPayouts.total,
      collected: collected.total, today_visits: todayVisits.count,
      unverified_tenants: unverified.count
    };
  });
  res.json(stats);
});

// ============================
//  BACKUP & RESTORE
// ============================
app.get('/api/backup', (req, res) => {
  const backup = {
    version: 3,
    export_date: new Date().toISOString(),
    branches: db.prepare('SELECT * FROM branches').all(),
    users: db.prepare('SELECT * FROM users').all(),
    lockers: db.prepare('SELECT * FROM lockers').all(),
    tenants: db.prepare('SELECT * FROM tenants').all(),
    payments: db.prepare('SELECT * FROM payments').all(),
    payouts: db.prepare('SELECT * FROM payouts').all(),
    visits: db.prepare('SELECT * FROM visits').all(),
    config: db.prepare('SELECT * FROM config').all()
  };
  res.json(backup);
});

// ============================
//  USERS MANAGEMENT
// ============================
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT u.id, u.username, u.name, u.role, u.branch_id, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id = b.id ORDER BY u.role, u.name').all();
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { username, password, name, role, branch_id } = req.body;
  const id = genId();
  try {
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, password, name, role || 'branch', branch_id || null);
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// CHANGE 3: Change Password for Branch Staff
app.put('/api/users/:id/password', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (req.params.id === 'admin001') return res.status(403).json({ error: 'Cannot change root user password' });

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(password, req.params.id);
  logInfo('User password changed', { userId: req.params.id });
  res.json({ ok: true });
});

// ============================
//  AUTO-SEED ON FIRST RUN
// ============================
function autoSeed() {
  const hasUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (hasUsers > 0) return; // Already seeded

  console.log('  First run — seeding default data...');

  // Admin user
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    'admin001', 'root', 'admin@123', 'Head Office Admin', 'headoffice', null
  );

  // Locker types
  const types = [
    { id: 'lt_l6_std', name: 'L6', variant: 'Standard', lpu: 6, uh: 2000, uw: 1075, ud: 700, lh: 637, lw: 529, ld: 621, w: 0, up: 0, desc: 'L6 Safe Deposit Lockers with Wooden Sleepers' },
    { id: 'lt_l10_std', name: 'L10', variant: 'Standard', lpu: 10, uh: 2000, uw: 1075, ud: 575, lh: 385, lw: 530, ld: 492, w: 475, up: 0, desc: 'L2/10 Safe Deposit Lockers with Wooden Sleepers' },
    { id: 'lt_l6_ultra', name: 'L6', variant: 'Secunex Ultra', lpu: 6, uh: 2000, uw: 1075, ud: 700, lh: 637, lw: 529, ld: 621, w: 0, up: 0, desc: 'L6 Secunex Ultra (Silver/Gold facia)' },
    { id: 'lt_l10_ultra', name: 'L10', variant: 'Secunex Ultra', lpu: 10, uh: 2000, uw: 1075, ud: 575, lh: 385, lw: 530, ld: 492, w: 475, up: 0, desc: 'L2/10 Secunex Ultra (Silver/Gold facia)' }
  ];
  const insType = db.prepare(`INSERT INTO locker_types (id, name, variant, lockers_per_unit, unit_height_mm, unit_width_mm, unit_depth_mm, locker_height_mm, locker_width_mm, locker_depth_mm, weight_kg, auto_size, description, is_upcoming) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  types.forEach(t => {
    const sz = classifySize(t.lh, t.lw, t.ld);
    insType.run(t.id, t.name, t.variant, t.lpu, t.uh, t.uw, t.ud, t.lh, t.lw, t.ld, t.w, sz, t.desc, t.up);
  });

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const insUnit = db.prepare('INSERT INTO units (id, branch_id, locker_type_id, unit_number, location, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insLock = db.prepare('INSERT INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  // ========== RS Puram branch ==========
  const brRS = 'br_rspuram';
  db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(brRS, 'RS Puram', 'RS Puram, Coimbatore', '', 'RS Puram, Coimbatore', '');
  db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(brRS);
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    genId(), 'rspuram', 'admin@123', 'RS Puram Staff', 'branch', brRS
  );

  // RS Puram: 8 L6 units (01-08, 6 lockers each) + 4 L10 units (01-04, 10 lockers each) = 88 lockers
  const txRS = db.transaction(() => {
    for (let i = 1; i <= 8; i++) {
      const uid = 'unit_rs_l6_' + i, unum = 'L6-' + String(i).padStart(2, '0');
      insUnit.run(uid, brRS, 'lt_l6_std', unum, 'RS Puram', 'active', '');
      for (let j = 0; j < 6; j++) insLock.run(genId(), brRS, uid, 'lt_l6_std', unum + '-' + LETTERS[j], 'Large', 'RS Puram', 0, 'vacant');
    }
    for (let i = 1; i <= 4; i++) {
      const uid = 'unit_rs_l10_' + i, unum = 'L10-' + String(i).padStart(2, '0');
      insUnit.run(uid, brRS, 'lt_l10_std', unum, 'RS Puram', 'active', '');
      for (let j = 0; j < 10; j++) insLock.run(genId(), brRS, uid, 'lt_l10_std', unum + '-' + LETTERS[j], 'Medium', 'RS Puram', 0, 'vacant');
    }
  });
  txRS();

  // ========== Hosur branch ==========
  const brHR = 'br_hosur';
  db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(brHR, 'Hosur', 'Hosur, Tamil Nadu', '', 'Hosur, Tamil Nadu', '');
  db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(brHR);
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    genId(), 'hosur', 'admin@123', 'Hosur Staff', 'branch', brHR
  );

  // Hosur: 50 lockers assorted across L6, L10, L6 Ultra, L10 Ultra
  // 2 x L6 Std units (12 lockers) + 1 x L10 Std unit (10 lockers) + 2 x L6 Ultra units (12 lockers) + 1 x L10 Ultra unit (10 lockers) + 1 x L6 Std unit (6 lockers) = 50 lockers
  const txHR = db.transaction(() => {
    // 2 x L6 Standard = 12 lockers
    for (let i = 1; i <= 2; i++) {
      const uid = 'unit_hr_l6s_' + i, unum = 'L6-' + String(i).padStart(2, '0');
      insUnit.run(uid, brHR, 'lt_l6_std', unum, 'Hosur', 'active', '');
      for (let j = 0; j < 6; j++) insLock.run(genId(), brHR, uid, 'lt_l6_std', unum + '-' + LETTERS[j], 'Large', 'Hosur', 0, 'vacant');
    }
    // 1 x L10 Standard = 10 lockers
    {
      const uid = 'unit_hr_l10s_1', unum = 'L10-01';
      insUnit.run(uid, brHR, 'lt_l10_std', unum, 'Hosur', 'active', '');
      for (let j = 0; j < 10; j++) insLock.run(genId(), brHR, uid, 'lt_l10_std', unum + '-' + LETTERS[j], 'Medium', 'Hosur', 0, 'vacant');
    }
    // 2 x L6 Ultra = 12 lockers
    for (let i = 1; i <= 2; i++) {
      const uid = 'unit_hr_l6u_' + i, unum = 'L6U-' + String(i).padStart(2, '0');
      insUnit.run(uid, brHR, 'lt_l6_ultra', unum, 'Hosur', 'active', '');
      for (let j = 0; j < 6; j++) insLock.run(genId(), brHR, uid, 'lt_l6_ultra', unum + '-' + LETTERS[j], 'Large', 'Hosur', 0, 'vacant');
    }
    // 1 x L10 Ultra = 10 lockers
    {
      const uid = 'unit_hr_l10u_1', unum = 'L10U-01';
      insUnit.run(uid, brHR, 'lt_l10_ultra', unum, 'Hosur', 'active', '');
      for (let j = 0; j < 10; j++) insLock.run(genId(), brHR, uid, 'lt_l10_ultra', unum + '-' + LETTERS[j], 'Medium', 'Hosur', 0, 'vacant');
    }
    // 1 x L6 Standard = 6 lockers (to reach 50 total)
    {
      const uid = 'unit_hr_l6s_3', unum = 'L6-03';
      insUnit.run(uid, brHR, 'lt_l6_std', unum, 'Hosur', 'active', '');
      for (let j = 0; j < 6; j++) insLock.run(genId(), brHR, uid, 'lt_l6_std', unum + '-' + LETTERS[j], 'Large', 'Hosur', 0, 'vacant');
    }
  });
  txHR();

  console.log('  ✅ Seeded: root/admin@123 (HO), rspuram/admin@123 (RS Puram, 88 lockers), hosur/admin@123 (Hosur, 50 lockers)');
}
autoSeed();

// ============================
//  DATABASE BACKUP & RESTORE
// ============================
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

app.get('/api/backup/create', (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `lockerhub_${timestamp}.db`);
    db.backup(backupFile).then(() => {
      const stats = fs.statSync(backupFile);
      res.json({ success: true, file: `lockerhub_${timestamp}.db`, size: stats.size });
    }).catch(err => res.status(500).json({ error: err.message }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backup/download', (req, res) => {
  const dbPath = path.join(DATA_DIR, 'lockerhub.db');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.download(dbPath, `lockerhub_backup_${timestamp}.db`);
});

app.get('/api/backup/list', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .sort().reverse()
      .map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size }));
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// ============================
//  HEALTH CHECK
// ============================
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================
//  LOG VIEWER API
// ============================
app.get('/api/logs', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 200;
    const level = req.query.level || ''; // filter: info, warn, error
    if (!fs.existsSync(APP_LOG)) return res.json({ logs: [], message: 'No logs yet' });

    const content = fs.readFileSync(APP_LOG, 'utf8');
    let allLines = content.trim().split('\n').filter(l => l.length > 0);

    // Filter by level if specified
    if (level) {
      allLines = allLines.filter(l => l.includes(`[${level.toUpperCase()}]`));
    }

    // Return last N lines (most recent first)
    const recent = allLines.slice(-lines).reverse();

    res.json({
      total: allLines.length,
      showing: recent.length,
      logs: recent
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pretty HTML log viewer (open in browser)
app.get('/api/logs/view', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 300;
    const level = req.query.level || '';
    if (!fs.existsSync(APP_LOG)) return res.send('<h2>No logs yet</h2>');

    const content = fs.readFileSync(APP_LOG, 'utf8');
    let allLines = content.trim().split('\n').filter(l => l.length > 0);
    if (level) allLines = allLines.filter(l => l.includes(`[${level.toUpperCase()}]`));
    const recent = allLines.slice(-lines).reverse();

    const html = `<!DOCTYPE html><html><head><title>LockerHub Logs</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; margin: 0; }
      h1 { color: #d4a843; font-size: 20px; margin-bottom: 8px; }
      .filters { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
      .filters a { padding: 6px 14px; background: #2a2a4a; color: #ccc; text-decoration: none; border-radius: 4px; font-size: 13px; }
      .filters a.active, .filters a:hover { background: #b8860b; color: #fff; }
      .stats { color: #888; font-size: 13px; margin-bottom: 12px; }
      .log-line { padding: 4px 8px; border-bottom: 1px solid #2a2a4a; font-size: 12px; line-height: 1.6; word-break: break-all; }
      .log-line.error { color: #ff6b6b; background: rgba(255,0,0,0.05); }
      .log-line.warn { color: #ffc078; }
      .log-line.info { color: #a0d0a0; }
      .refresh { position: fixed; top: 16px; right: 16px; padding: 8px 16px; background: #b8860b; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    </style></head><body>
    <h1>LockerHub — Live Logs</h1>
    <div class="filters">
      <a href="/api/logs/view" ${!level ? 'class="active"' : ''}>All</a>
      <a href="/api/logs/view?level=error" ${level === 'error' ? 'class="active"' : ''}>Errors</a>
      <a href="/api/logs/view?level=warn" ${level === 'warn' ? 'class="active"' : ''}>Warnings</a>
      <a href="/api/logs/view?level=info" ${level === 'info' ? 'class="active"' : ''}>Info</a>
    </div>
    <div class="stats">Showing ${recent.length} of ${allLines.length} entries</div>
    <button class="refresh" onclick="location.reload()">Refresh</button>
    <div>${recent.map(l => {
      const cls = l.includes('[ERROR]') ? 'error' : l.includes('[WARN]') ? 'warn' : 'info';
      return '<div class="log-line ' + cls + '">' + l.replace(/</g, '&lt;') + '</div>';
    }).join('')}</div>
    </body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ============================
//  CUSTOMER LOGIN & PORTAL
// ============================
app.post('/api/customer-login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  // Check password against any tenant record with this phone
  const firstMatch = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name
    FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
    LEFT JOIN branches b ON t.branch_id = b.id
    WHERE t.phone = ? AND t.customer_password = ?`).get(phone, password);
  if (!firstMatch) {
    logWarn('Customer login failed', { phone, ip: req.ip });
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }
  // Fetch ALL tenant records for this phone (multi-branch / multi-locker)
  const allTenants = db.prepare(`SELECT t.id, t.name, t.phone, t.branch_id, t.locker_id, t.lease_start, t.lease_end, t.annual_rent, t.deposit,
    l.number as locker_number, b.name as branch_name
    FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
    LEFT JOIN branches b ON t.branch_id = b.id
    WHERE t.phone = ? ORDER BY b.name`).all(phone);
  logInfo('Customer login success', { phone, tenant: firstMatch.name, totalLockers: allTenants.length });
  res.json({
    id: firstMatch.id, name: firstMatch.name, role: 'customer', phone: firstMatch.phone,
    branch_id: firstMatch.branch_id, branch_name: firstMatch.branch_name,
    locker_id: firstMatch.locker_id, locker_number: firstMatch.locker_number,
    lease_start: firstMatch.lease_start, lease_end: firstMatch.lease_end,
    annual_rent: firstMatch.annual_rent, deposit: firstMatch.deposit,
    tenants: allTenants
  });
});

// Set/Reset customer password (HO only) — sets for ALL tenant records with same phone
app.post('/api/tenants/:id/set-password', (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const tenant = db.prepare('SELECT id, name, phone FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  // Set password for ALL tenant records with same phone number (multi-branch support)
  const result = db.prepare('UPDATE tenants SET customer_password = ? WHERE phone = ?').run(password, tenant.phone);
  logInfo('Customer password set', { tenant: tenant.name, phone: tenant.phone, recordsUpdated: result.changes });
  res.json({ success: true, message: `Password set for ${tenant.name} (${result.changes} locker record${result.changes > 1 ? 's' : ''})` });
});

// Customer payments (supports single tenant or all tenants by phone)
app.get('/api/customer/:tenantId/payments', (req, res) => {
  const { phone } = req.query;
  if (phone) {
    // Multi-tenant: get all tenant IDs for this phone, then fetch all payments
    const tenantIds = db.prepare('SELECT id FROM tenants WHERE phone = ?').all(phone).map(t => t.id);
    if (tenantIds.length === 0) return res.json([]);
    const placeholders = tenantIds.map(() => '?').join(',');
    const payments = db.prepare(`SELECT p.*, l.number as locker_number, b.name as branch_name
      FROM payments p LEFT JOIN lockers l ON p.locker_id = l.id
      LEFT JOIN branches b ON p.branch_id = b.id
      WHERE p.tenant_id IN (${placeholders}) ORDER BY p.created_at DESC`).all(...tenantIds);
    return res.json(payments);
  }
  const payments = db.prepare(`SELECT p.*, l.number as locker_number, b.name as branch_name
    FROM payments p LEFT JOIN lockers l ON p.locker_id = l.id
    LEFT JOIN branches b ON p.branch_id = b.id
    WHERE p.tenant_id = ? ORDER BY p.created_at DESC`).all(req.params.tenantId);
  res.json(payments);
});

// ============================
//  APPOINTMENTS
// ============================
app.get('/api/appointments', (req, res) => {
  const { branch_id, tenant_id, phone, status, from, to } = req.query;
  let sql = `SELECT a.*, t.name as tenant_name, t.phone as tenant_phone, l.number as locker_number, b.name as branch_name
    FROM appointments a
    LEFT JOIN tenants t ON a.tenant_id = t.id
    LEFT JOIN lockers l ON a.locker_id = l.id
    LEFT JOIN branches b ON a.branch_id = b.id WHERE 1=1`;
  const params = [];
  if (branch_id) { sql += ' AND a.branch_id = ?'; params.push(branch_id); }
  if (tenant_id) { sql += ' AND a.tenant_id = ?'; params.push(tenant_id); }
  if (phone) {
    // Multi-tenant: get all tenant IDs for this phone
    const tenantIds = db.prepare('SELECT id FROM tenants WHERE phone = ?').all(phone).map(t => t.id);
    if (tenantIds.length > 0) {
      const placeholders = tenantIds.map(() => '?').join(',');
      sql += ` AND a.tenant_id IN (${placeholders})`;
      params.push(...tenantIds);
    } else {
      return res.json([]);
    }
  }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (from) { sql += ' AND a.requested_date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.requested_date <= ?'; params.push(to); }
  sql += ' ORDER BY a.requested_date DESC, a.requested_time DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/appointments', (req, res) => {
  const d = req.body;
  if (!d.branch_id || !d.tenant_id || !d.requested_date) {
    return res.status(400).json({ error: 'Branch, tenant, and date are required' });
  }
  const id = genId();
  const locker_id = d.locker_id || '';
  const status = d.booked_by === 'customer' ? 'Pending' : 'Approved';
  db.prepare(`INSERT INTO appointments (id, branch_id, tenant_id, locker_id, requested_date, requested_time, purpose, status, booked_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, d.branch_id, d.tenant_id, locker_id, d.requested_date, d.requested_time || '', d.purpose || 'Locker Access', status, d.booked_by || 'customer', d.notes || '');
  logInfo('Appointment created', { id, tenant: d.tenant_id, date: d.requested_date, booked_by: d.booked_by || 'customer', status });
  res.json({ success: true, id, status });
});

app.put('/api/appointments/:id/status', (req, res) => {
  const { status, admin_notes } = req.body;
  if (!['Approved', 'Rejected', 'Completed', 'Cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  db.prepare('UPDATE appointments SET status = ?, admin_notes = COALESCE(?, admin_notes), approved_by = ? WHERE id = ?')
    .run(status, admin_notes || null, req.body.approved_by || '', req.params.id);

  // CHANGE 6: Auto-log visit on appointment completion
  if (status === 'Completed') {
    const visitId = genId();
    db.prepare(`INSERT INTO visits (id, branch_id, tenant_id, locker_id, datetime, purpose, duration, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(visitId, appt.branch_id, appt.tenant_id, appt.locker_id, new Date().toISOString(), appt.purpose, '', 'Auto-logged from appointment');
    logInfo('Visit auto-logged from appointment', { visitId, appointmentId: req.params.id });
  }

  logInfo('Appointment status updated', { id: req.params.id, status });
  res.json({ success: true });
});

app.delete('/api/appointments/:id', (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run('Cancelled', req.params.id);
  logInfo('Appointment cancelled', { id: req.params.id });
  res.json({ success: true });
});

// ============================
//  GLOBAL ERROR HANDLER
// ============================
app.use((err, req, res, next) => {
  logError(`Unhandled error: ${err.message}`, {
    method: req.method,
    url: req.originalUrl,
    stack: err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : ''
  });
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Catch uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logError('UNHANDLED REJECTION', { message: String(reason) });
});

// ============================
//  START SERVER
// ============================
app.listen(PORT, '0.0.0.0', () => {
  logInfo('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         LockerHub Server Running         ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}          ║`);
  console.log('  ║  Network: http://<your-ip>:' + PORT + '       ║');
  console.log('  ║                                          ║');
  console.log('  ║  All branches connect via browser to     ║');
  console.log('  ║  the Network URL above.                  ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  // Run overdue check on startup
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = db.prepare("UPDATE payments SET status = 'Overdue' WHERE status = 'Pending' AND due_date != '' AND due_date < ?").run(today);
    if (result.changes > 0) logInfo('Startup overdue check', { marked: result.changes });
  } catch (e) { logError('Startup overdue check failed', { error: e.message }); }

  // Run overdue check every 6 hours
  setInterval(() => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = db.prepare("UPDATE payments SET status = 'Overdue' WHERE status = 'Pending' AND due_date != '' AND due_date < ?").run(today);
      if (result.changes > 0) logInfo('Periodic overdue check', { marked: result.changes });
    } catch (e) { logError('Periodic overdue check failed', { error: e.message }); }
  }, 6 * 60 * 60 * 1000);
});
