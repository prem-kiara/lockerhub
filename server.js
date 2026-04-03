const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');

// Multer setup for KYC file uploads (memory storage — files go to SharePoint, not disk)
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    // Allow common document/image types
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'application/pdf',
      'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDF files are allowed'), false);
    }
  }
});

// Load .env file
require('dotenv').config();

// ============================
//  SECURITY CONFIGURATION
// ============================
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE-THIS-IN-PRODUCTION-' + require('crypto').randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const BCRYPT_ROUNDS = 10;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes('change')) {
  console.warn('  ⚠️  WARNING: Using default JWT_SECRET. Set JWT_SECRET in .env for production!');
}
const { generatePdfBuffer } = require('./allotment-form');
const { generateReceiptBuffer } = require('./receipt-generator');

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

// ============================
//  SECURITY MIDDLEWARE
// ============================

// Trust proxy (Nginx/Certbot reverse proxy sets X-Forwarded-For)
app.set('trust proxy', 1);

// Helmet - secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for SPA
  crossOriginEmbedderPolicy: false
}));

// HTTPS redirect in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

// CORS - restrict origins in production
const corsOrigins = process.env.CORS_ORIGINS || '*';
app.use(cors({
  origin: corsOrigins === '*' ? true : corsOrigins.split(',').map(s => s.trim()),
  credentials: true
}));

// Body parser with reasonable limit
app.use(express.json({ limit: '10mb' }));

// General API rate limiting — 1000 requests per 15 min per IP (generous for SPA)
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 min
  max: parseInt(process.env.RATE_LIMIT_MAX) || 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

// Rate limiting for login endpoints — 30 attempts per 5 min per IP
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min window (resets faster)
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please wait 5 minutes and try again' }
});

// Apply general rate limit to all API routes
app.use('/api/', apiLimiter);

// ============================
//  JWT AUTH MIDDLEWARE
// ============================
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Middleware: require valid JWT token
function requireAuth(req, res, next) {
  // Support token via Authorization header OR query param (for WebView downloads)
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token;
    delete req.query.token; // Remove from query to prevent logging
  }
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired, please login again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Middleware: require specific roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Middleware: enforce branch scoping (branch staff can only access their own branch)
function enforceBranchScope(req, res, next) {
  if (!req.user) return next();
  if (req.user.role === 'headoffice') return next(); // HO can access all
  // For branch staff, override branch_id to their own
  if (req.user.role === 'branch' && req.user.branch_id) {
    if (req.query.branch_id && req.query.branch_id !== req.user.branch_id && req.query.branch_id !== 'all') {
      return res.status(403).json({ error: 'Access denied: cannot access other branches' });
    }
    // Force their branch_id in queries
    if (req.query.branch_id === 'all') {
      req.query.branch_id = req.user.branch_id;
    }
    // Force in body for POST/PUT
    if (req.body && req.body.branch_id && req.body.branch_id !== req.user.branch_id) {
      req.body.branch_id = req.user.branch_id;
    }
  }
  next();
}

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

  CREATE TABLE IF NOT EXISTS room_layouts (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL UNIQUE,
    room_polygon TEXT DEFAULT '[]',
    room_elements TEXT DEFAULT '[]',
    unit_placements TEXT DEFAULT '{}',
    room_width_ft REAL DEFAULT 20,
    room_height_ft REAL DEFAULT 15,
    status TEXT DEFAULT 'pending',
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
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

  CREATE TABLE IF NOT EXISTS esign_requests (
    id TEXT PRIMARY KEY,
    branch_id TEXT,
    tenant_id TEXT,
    document_type TEXT DEFAULT 'agreement',
    document_id TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    signer_name TEXT DEFAULT '',
    signer_identifier TEXT DEFAULT '',
    sign_type TEXT DEFAULT 'aadhaar',
    status TEXT DEFAULT 'pending',
    digio_doc_id TEXT DEFAULT '',
    auth_url TEXT DEFAULT '',
    signed_file_url TEXT DEFAULT '',
    expire_in_days INTEGER DEFAULT 10,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    branch_id TEXT DEFAULT '',
    q1_time_satisfaction INTEGER DEFAULT 0,
    q2_procedure_explained INTEGER DEFAULT 0,
    q3_locker_suits INTEGER DEFAULT 0,
    q4_procedure_simple INTEGER DEFAULT 0,
    q5_safety_adequate INTEGER DEFAULT 0,
    q6_ambience_pleasant INTEGER DEFAULT 0,
    q7_staff_oriented INTEGER DEFAULT 0,
    reason_chose TEXT DEFAULT '',
    nps_score INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 0,
    satisfaction_pct REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id)
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    locker_size TEXT DEFAULT '',
    branch_id TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'New',
    created_by TEXT DEFAULT '',
    created_by_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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

// Emergency contact name migration
addColumnIfMissing('tenants', 'emergency_name', "TEXT DEFAULT ''");

// Customer portal migrations
addColumnIfMissing('tenants', 'customer_password', "TEXT DEFAULT ''");
addColumnIfMissing('tenants', 'account_status', "TEXT DEFAULT 'Active'");
addColumnIfMissing('tenants', 'closed_at', "TEXT DEFAULT ''");
addColumnIfMissing('tenants', 'closed_reason', "TEXT DEFAULT ''");

// Branches table migrations
addColumnIfMissing('branches', 'location', "TEXT DEFAULT ''");
addColumnIfMissing('branches', 'manager_name', "TEXT DEFAULT ''");

// Locker types table migrations (CHANGE 2)
addColumnIfMissing('locker_types', 'annual_rent', 'REAL DEFAULT 0');
addColumnIfMissing('locker_types', 'deposit', 'REAL DEFAULT 0');

// E-sign table migrations
addColumnIfMissing('esign_requests', 'onedrive_url', "TEXT DEFAULT ''");

// Leads table migrations
addColumnIfMissing('leads', 'visit_time', "TEXT DEFAULT ''");
addColumnIfMissing('leads', 'converted_tenant_id', "TEXT DEFAULT ''");
addColumnIfMissing('leads', 'source', "TEXT DEFAULT ''");

// Nominee details
addColumnIfMissing('tenants', 'nominee_name', "TEXT DEFAULT ''");
addColumnIfMissing('tenants', 'nominee_phone', "TEXT DEFAULT ''");
addColumnIfMissing('tenants', 'nominee_aadhaar', "TEXT DEFAULT ''");
addColumnIfMissing('tenants', 'nominee_pan', "TEXT DEFAULT ''");

// KYC document tracking (JSON: { docType: { uploaded: true, filename, sharepoint_url, uploaded_at } })
addColumnIfMissing('tenants', 'kyc_documents', "TEXT DEFAULT '{}'");

// Lead telecalling notes table
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_notes (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_by TEXT DEFAULT '',
    created_by_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  -- Audit log for compliance
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    user_name TEXT DEFAULT '',
    details TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
`);

// Migration: Update locker type rates (L10 Large: 20k/3L, L6 Medium: 10k/2L)
// Only updates the locker_types template — existing tenants keep their original rates
(function updateLockerTypeRates() {
  const rateUpdates = [
    { prefix: 'lt_l6',  rent: 10000, dep: 200000 },
    { prefix: 'lt_l10', rent: 20000, dep: 300000 }
  ];
  rateUpdates.forEach(({ prefix, rent, dep }) => {
    const types = db.prepare("SELECT id, annual_rent, deposit FROM locker_types WHERE id LIKE ?").all(prefix + '%');
    types.forEach(t => {
      if (t.annual_rent !== rent || t.deposit !== dep) {
        db.prepare('UPDATE locker_types SET annual_rent = ?, deposit = ? WHERE id = ?').run(rent, dep, t.id);
        logInfo('Migration: updated locker type rates', { id: t.id, rent, deposit: dep });
      }
    });
  });
})();

// Performance indexes
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tenants_phone ON tenants(phone);
  CREATE INDEX IF NOT EXISTS idx_tenants_branch ON tenants(branch_id);
  CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_payments_branch ON payments(branch_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_lockers_branch ON lockers(branch_id);
  CREATE INDEX IF NOT EXISTS idx_lockers_status ON lockers(status);
  CREATE INDEX IF NOT EXISTS idx_lockers_unit ON lockers(unit_id);
  CREATE INDEX IF NOT EXISTS idx_visits_branch ON visits(branch_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_branch ON appointments(branch_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_tenant ON appointments(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_esign_digio ON esign_requests(digio_doc_id);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_created_by ON leads(created_by);
  CREATE INDEX IF NOT EXISTS idx_feedback_tenant ON feedback(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id);
`);

logInfo('Database migrations complete');

// Migration: Seed lead agent users if not already present
(function seedLeadAgents() {
  const leadAgents = [
    'Guna', 'Nambi', 'Suren', 'Eashwar', 'Pramoth', 'Gowtham', 'Selvakumar',
    'Srinish', 'Harisudhan', 'Rithiesh', 'Gokul', 'Anbu', 'Karthik', 'Deepak',
    'Vignesh', 'Arun', 'Praveen', 'Mohan', 'Rajesh', 'Dinesh'
  ];
  const leadHash = bcrypt.hashSync('lead@123', 10);
  leadAgents.forEach(name => {
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(name.toLowerCase());
    if (!existing) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, name.toLowerCase(), leadHash, name, 'lead_agent', null
      );
      logInfo('Migration: created lead agent', { name, username: name.toLowerCase() });
    }
  });
})();

// Helper: compute bg_status based on all verification criteria
function computeBgStatus(tenant) {
  const hasCustomerDocs = tenant.bg_aadhaar && tenant.bg_pan;
  const hasNominee = tenant.nominee_name && tenant.nominee_phone && tenant.nominee_aadhaar && tenant.nominee_pan;
  let kycComplete = false;
  try {
    const kyc = typeof tenant.kyc_documents === 'string' ? JSON.parse(tenant.kyc_documents || '{}') : (tenant.kyc_documents || {});
    const required = ['customer_aadhaar_front', 'customer_aadhaar_back', 'customer_pan',
      'nominee_aadhaar_front', 'nominee_aadhaar_back', 'nominee_pan'];
    kycComplete = required.every(d => kyc[d] && kyc[d].uploaded);
  } catch(e) {}
  return (hasCustomerDocs && hasNominee && kycComplete) ? 'Verified' : 'Pending';
}

// Auto-fix bg_status on startup: recompute for all tenants
(function fixBgStatus() {
  const tenants = db.prepare(`SELECT id, bg_aadhaar, bg_pan, nominee_name, nominee_phone, nominee_aadhaar, nominee_pan, kyc_documents, bg_status FROM tenants`).all();
  let fixed = 0;
  for (const t of tenants) {
    const correctStatus = computeBgStatus(t);
    if (t.bg_status !== correctStatus) {
      db.prepare('UPDATE tenants SET bg_status = ? WHERE id = ?').run(correctStatus, t.id);
      fixed++;
    }
  }
  if (fixed > 0) console.log(`  Fixed bg_status for ${fixed} tenant(s)`);
})();

// Guarantee root admin always exists (even if lead agents were seeded first)
(function ensureRootAdmin() {
  const rootExists = db.prepare("SELECT id FROM users WHERE LOWER(username) = 'root'").get();
  if (!rootExists) {
    const hash = bcrypt.hashSync('adcc@123', 10);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      'admin001', 'root', hash, 'Head Office Admin', 'headoffice', null
    );
    logInfo('Migration: created root admin user (guaranteed default)');
  }
})();

// Guarantee HO admin user always exists
(function ensureHOAdmin() {
  const exists = db.prepare("SELECT id FROM users WHERE LOWER(username) = 'ho'").get();
  if (!exists) {
    const hash = bcrypt.hashSync('admin@123', 10);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      Date.now().toString(36) + Math.random().toString(36).slice(2, 9), 'ho', hash, 'Head Office Admin', 'headoffice', null
    );
    logInfo('Migration: created HO admin user');
  }
})();

// Guarantee Google reviewer account always exists
(function ensureGoogleReviewer() {
  const exists = db.prepare("SELECT id FROM users WHERE LOWER(username) = 'googlereviewer'").get();
  if (!exists) {
    const hash = bcrypt.hashSync('Review@2026', 10);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      Date.now().toString(36) + Math.random().toString(36).slice(2, 9), 'googlereviewer', hash, 'Google Reviewer', 'headoffice', null
    );
    logInfo('Migration: created Google reviewer account');
  }
})();

// Guarantee RS Puram branch, staff user, locker types, units, and lockers always exist
(function ensureDefaultData() {
  const _gid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // 1. Ensure RS Puram branch
  const branchExists = db.prepare("SELECT id FROM branches WHERE id = 'br_rspuram'").get();
  if (!branchExists) {
    db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(
      'br_rspuram', 'RS Puram', 'RS Puram, Coimbatore', '', 'RS Puram, Coimbatore', ''
    );
    logInfo('Migration: created RS Puram branch');
  }
  // Ensure config row
  const configExists = db.prepare("SELECT branch_id FROM config WHERE branch_id = 'br_rspuram'").get();
  if (!configExists) {
    db.prepare('INSERT INTO config (branch_id) VALUES (?)').run('br_rspuram');
  }

  // 2. Ensure RS Puram staff user
  const staffExists = db.prepare("SELECT id FROM users WHERE LOWER(username) = 'rspuram'").get();
  if (!staffExists) {
    const staffHash = bcrypt.hashSync('admin@123', 10);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      _gid(), 'rspuram', staffHash, 'RS Puram Staff', 'branch', 'br_rspuram'
    );
    logInfo('Migration: created RS Puram staff user');
  }

  // 3. Ensure locker types exist
  const types = [
    { id: 'lt_l6_std', name: 'L6', variant: 'Standard', lpu: 6, uh: 2000, uw: 1075, ud: 700, lh: 637, lw: 529, ld: 621, w: 0, up: 0, rent: 10000, dep: 200000, desc: 'L6 Hi-Tech Lockers with Wooden Sleepers' },
    { id: 'lt_l10_std', name: 'L10', variant: 'Standard', lpu: 10, uh: 2000, uw: 1075, ud: 575, lh: 385, lw: 530, ld: 492, w: 475, up: 0, rent: 20000, dep: 300000, desc: 'L2/10 Hi-Tech Lockers with Wooden Sleepers' },
    { id: 'lt_l6_ultra', name: 'L6U', variant: 'Secunex Ultra', lpu: 6, uh: 2000, uw: 1075, ud: 700, lh: 637, lw: 529, ld: 621, w: 0, up: 0, rent: 10000, dep: 200000, desc: 'L6 Secunex Ultra (Silver/Gold facia)' },
    { id: 'lt_l10_ultra', name: 'L10U', variant: 'Secunex Ultra', lpu: 10, uh: 2000, uw: 1075, ud: 575, lh: 385, lw: 530, ld: 492, w: 475, up: 0, rent: 20000, dep: 300000, desc: 'L2/10 Secunex Ultra (Silver/Gold facia)' }
  ];
  const insType = db.prepare(`INSERT OR IGNORE INTO locker_types (id, name, variant, lockers_per_unit, unit_height_mm, unit_width_mm, unit_depth_mm, locker_height_mm, locker_width_mm, locker_depth_mm, weight_kg, auto_size, description, is_upcoming, annual_rent, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  types.forEach(t => {
    const sz = classifySize(t.lh, t.lw, t.ld);
    insType.run(t.id, t.name, t.variant, t.lpu, t.uh, t.uw, t.ud, t.lh, t.lw, t.ld, t.w, sz, t.desc, t.up, t.rent, t.dep);
  });

  // 4. Ensure RS Puram units and lockers exist
  const lockerCount = db.prepare("SELECT COUNT(*) as c FROM lockers WHERE branch_id = 'br_rspuram'").get().c;
  if (lockerCount === 0) {
    const insUnit = db.prepare('INSERT OR IGNORE INTO units (id, branch_id, locker_type_id, unit_number, location, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insLock = db.prepare('INSERT INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const brRS = 'br_rspuram';

    const txRS = db.transaction(() => {
      // 8 L6 units (6 lockers each = 48)
      for (let i = 1; i <= 8; i++) {
        const uid = 'unit_rs_l6_' + i, unum = 'L6-' + String(i).padStart(2, '0');
        insUnit.run(uid, brRS, 'lt_l6_std', unum, 'RS Puram', 'active', '');
        for (let j = 0; j < 6; j++) insLock.run(_gid(), brRS, uid, 'lt_l6_std', unum + '-' + LETTERS[j], 'Large', 'RS Puram', 0, 'vacant');
      }
      // 4 L10 units (10 lockers each = 40)
      for (let i = 1; i <= 4; i++) {
        const uid = 'unit_rs_l10_' + i, unum = 'L10-' + String(i).padStart(2, '0');
        insUnit.run(uid, brRS, 'lt_l10_std', unum, 'RS Puram', 'active', '');
        for (let j = 0; j < 10; j++) insLock.run(_gid(), brRS, uid, 'lt_l10_std', unum + '-' + LETTERS[j], 'Medium', 'RS Puram', 0, 'vacant');
      }
    });
    txRS();
    logInfo('Migration: seeded RS Puram 88 lockers (8×L6 + 4×L10)');
  }
})();

// ============================
//  HELPER: Generate ID
// ============================
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// Audit logging for compliance
function auditLog(action, entityType, entityId, req, details = '') {
  try {
    const userId = req.user ? req.user.id : '';
    const userName = req.user ? req.user.name : '';
    const ip = req.ip || req.connection?.remoteAddress || '';
    db.prepare('INSERT INTO audit_log (action, entity_type, entity_id, user_id, user_name, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      action, entityType, entityId, userId, userName, typeof details === 'object' ? JSON.stringify(details) : details, ip
    );
  } catch (e) { logError('Audit log failed', { error: e.message }); }
}

// ============================
//  AUTH & LOGIN
// ============================
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = db.prepare('SELECT u.*, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id = b.id WHERE LOWER(u.username) = LOWER(?)').get(username);
    if (!user) {
      logWarn('Login failed - user not found', { username, ip: req.ip });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Support both bcrypt hashed and legacy plaintext passwords
    let passwordValid = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
      passwordValid = await bcrypt.compare(password, user.password);
    } else {
      // Legacy plaintext comparison - auto-upgrade to bcrypt on successful login
      passwordValid = (user.password === password);
      if (passwordValid) {
        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);
        logInfo('Password auto-upgraded to bcrypt', { username });
      }
    }

    if (!passwordValid) {
      logWarn('Login failed - wrong password', { username, ip: req.ip });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate JWT token
    const tokenPayload = { id: user.id, username: user.username, name: user.name, role: user.role, branch_id: user.branch_id };
    const token = generateToken(tokenPayload);

    logInfo('Login success', { username, role: user.role, branch: user.branch_name });
    res.json({
      token,
      id: user.id, name: user.name, role: user.role,
      branch_id: user.branch_id, branch_name: user.branch_name
    });
  } catch (err) {
    logError('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================
//  TOKEN REFRESH
// ============================
app.post('/api/refresh-token', requireAuth, (req, res) => {
  const tokenPayload = { id: req.user.id, username: req.user.username, name: req.user.name, role: req.user.role, branch_id: req.user.branch_id };
  const token = generateToken(tokenPayload);
  res.json({ token });
});

// ============================
//  BRANCHES
// ============================
app.get('/api/branches', requireAuth, (req, res) => {
  const branches = db.prepare('SELECT * FROM branches ORDER BY name').all();
  res.json(branches);
});

app.post('/api/branches', requireAuth, requireRole('headoffice'), (req, res) => {
  const { name, address, phone, location, manager_name } = req.body;
  const id = genId();
  db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, address || '', phone || '', location || '', manager_name || '');
  db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(id);
  logInfo('Branch created', { id, name, location });
  res.json({ id, name });
});

// CHANGE 1: Branch Setup Wizard - Create branch + config + user + units + lockers
app.post('/api/branches/setup', requireAuth, requireRole('headoffice'), async (req, res) => {
  const { name, address, phone, location, manager_name, type_units } = req.body;

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
    const hashedStaffPassword = await bcrypt.hash(staffPassword, BCRYPT_ROUNDS);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      staffUserId, staffUsername, hashedStaffPassword, name + ' Manager', 'branch', branchId
    );

    let totalLockers = 0;

    // 4. For each locker type requested, create units and lockers
    const typeUnitsList = type_units || [];
    for (const tu of typeUnitsList) {
      const typeId = tu.type_id;
      const unitCount = parseInt(tu.count) || 0;
      if (!typeId || unitCount <= 0) continue;

      const typeInfo = db.prepare('SELECT * FROM locker_types WHERE id = ?').get(typeId);
      if (!typeInfo) continue;

      const lockersPerUnit = typeInfo.lockers_per_unit || 6;
      // Build prefix from type name + variant
      let prefix = typeInfo.name;
      if (typeInfo.variant && typeInfo.variant !== 'Standard') {
        prefix += typeInfo.variant.charAt(0).toUpperCase(); // e.g., L6S for Secunex, L10S
      }
      const autoSize = typeInfo.auto_size || 'Medium';

      for (let u = 1; u <= unitCount; u++) {
        const unitId = genId();
        const unitNumber = `${prefix}-${u.toString().padStart(2, '0')}`;

        // Create unit
        db.prepare('INSERT INTO units (id, branch_id, locker_type_id, unit_number, location, status) VALUES (?, ?, ?, ?, ?, ?)')
          .run(unitId, branchId, typeId, unitNumber, '', 'active');

        // Create lockers for this unit
        for (let l = 0; l < lockersPerUnit; l++) {
          const lockerId = genId();
          const lockerNumber = unitNumber + '-' + LETTERS[l];
          db.prepare('INSERT INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(lockerId, branchId, unitId, typeId, lockerNumber, autoSize, '', 0, 'vacant');
          totalLockers++;
        }
      }
    }

    logInfo('Branch setup complete', { id: branchId, name, totalLockers, staffUser: staffUsername });
    res.json({ id: branchId, name, totalLockers, staffUserId, staffUsername, passwordNote: 'Default password is admin@123 — change immediately via Users management' });
  } catch (error) {
    logError('Branch setup failed', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/branches/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  const { name, address, phone, location, manager_name } = req.body;
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  db.prepare('UPDATE branches SET name = ?, address = ?, phone = ?, location = ?, manager_name = ? WHERE id = ?')
    .run(name || branch.name, address || '', phone || '', location || '', manager_name || '', req.params.id);
  logInfo('Branch updated', { id: req.params.id, name });
  res.json({ success: true });
});

app.delete('/api/branches/:id', requireAuth, requireRole('headoffice'), (req, res) => {
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
app.get('/api/locker-types', requireAuth, (req, res) => {
  const types = db.prepare('SELECT * FROM locker_types ORDER BY is_upcoming, name, variant').all();
  res.json(types);
});

app.post('/api/locker-types', requireAuth, requireRole('headoffice'), (req, res) => {
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

app.put('/api/locker-types/:id', requireAuth, requireRole('headoffice'), (req, res) => {
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

app.delete('/api/locker-types/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) as cnt FROM units WHERE locker_type_id = ?').get(req.params.id);
  if (inUse && inUse.cnt > 0) {
    return res.status(400).json({ error: `Cannot delete — this locker type is used by ${inUse.cnt} unit(s). Remove those units first.` });
  }
  const lockerRef = db.prepare('SELECT COUNT(*) as cnt FROM lockers WHERE locker_type_id = ?').get(req.params.id);
  if (lockerRef && lockerRef.cnt > 0) {
    return res.status(400).json({ error: `Cannot delete — ${lockerRef.cnt} locker(s) still reference this type.` });
  }
  db.prepare('DELETE FROM locker_types WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  UNITS (Physical cabinets)
// ============================
app.get('/api/units', requireAuth, enforceBranchScope, (req, res) => {
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
  const prefix = lt.name; // e.g., "L6", "L10", "L6U", "L10U"
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

// Helper: generate next receipt number (ensures uniqueness)
function getNextReceiptNo() {
  const last = db.prepare("SELECT receipt_no FROM payments WHERE receipt_no LIKE 'RCP-%' ORDER BY receipt_no DESC LIMIT 1").get();
  if (!last || !last.receipt_no) return 'RCP-0001';
  const num = parseInt(last.receipt_no.replace('RCP-', '')) || 0;
  let next = num + 1;
  let receiptNo = 'RCP-' + String(next).padStart(4, '0');
  // Ensure uniqueness
  while (db.prepare('SELECT 1 FROM payments WHERE receipt_no = ?').get(receiptNo)) {
    next++;
    receiptNo = 'RCP-' + String(next).padStart(4, '0');
  }
  return receiptNo;
}

// GET next available unit number
app.get('/api/units/next-number', requireAuth, (req, res) => {
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

app.post('/api/units', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
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

app.put('/api/units/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
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

app.delete('/api/units/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  const occupied = db.prepare("SELECT COUNT(*) as cnt FROM lockers l JOIN tenants t ON t.locker_id = l.id WHERE l.unit_id = ? AND (t.account_status IS NULL OR t.account_status != 'Closed')").get(req.params.id);
  if (occupied && occupied.cnt > 0) {
    return res.status(400).json({ error: `Cannot delete — this unit has ${occupied.cnt} locker(s) with active tenants. Close or reassign those tenants first.` });
  }
  db.prepare('DELETE FROM lockers WHERE unit_id = ?').run(req.params.id);
  db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  LOCKERS
// ============================
app.get('/api/lockers', requireAuth, enforceBranchScope, (req, res) => {
  const { branch_id } = req.query;
  let lockers;
  if (branch_id && branch_id !== 'all') {
    lockers = db.prepare(`SELECT l.*,
      t.name as tenant_name, t.phone as tenant_phone,
      lt.name as type_name, lt.variant as type_variant,
      lt.annual_rent as type_annual_rent, lt.deposit as type_deposit,
      u.unit_number
      FROM lockers l
      LEFT JOIN tenants t ON t.locker_id = l.id
      LEFT JOIN locker_types lt ON l.locker_type_id = lt.id
      LEFT JOIN units u ON l.unit_id = u.id
      WHERE l.branch_id = ? ORDER BY l.number`).all(branch_id);
  } else {
    lockers = db.prepare(`SELECT l.*,
      b.name as branch_name,
      t.name as tenant_name, t.phone as tenant_phone,
      lt.name as type_name, lt.variant as type_variant,
      lt.annual_rent as type_annual_rent, lt.deposit as type_deposit,
      u.unit_number
      FROM lockers l
      JOIN branches b ON l.branch_id = b.id
      LEFT JOIN tenants t ON t.locker_id = l.id
      LEFT JOIN locker_types lt ON l.locker_type_id = lt.id
      LEFT JOIN units u ON l.unit_id = u.id
      ORDER BY b.name, l.number`).all();
  }
  res.json(lockers);
});

// Get lockers for a specific unit (with tenant details)
app.get('/api/units/:id/lockers', requireAuth, (req, res) => {
  const lockers = db.prepare(`SELECT l.*,
    t.name as tenant_name, t.phone as tenant_phone, t.email as tenant_email,
    t.annual_rent as tenant_annual_rent, t.deposit as tenant_deposit,
    t.lease_start, t.lease_end, t.bg_status,
    lt.name as type_name, lt.variant as type_variant,
    lt.annual_rent as type_annual_rent, lt.deposit as type_deposit
    FROM lockers l
    LEFT JOIN tenants t ON t.locker_id = l.id
    LEFT JOIN locker_types lt ON l.locker_type_id = lt.id
    WHERE l.unit_id = ? ORDER BY l.number`).all(req.params.id);
  res.json(lockers);
});

app.post('/api/lockers', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const { branch_id, number, size, location, rent, notes } = req.body;
  const id = genId();
  db.prepare('INSERT INTO lockers (id, branch_id, number, size, location, rent, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, branch_id, number, size || 'Large', location || '', rent || 0, 'vacant', notes || '');
  res.json({ id });
});

app.post('/api/lockers/bulk', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
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

app.put('/api/lockers/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const d = req.body;
  const fields = [];
  const vals = [];
  const allowed = ['number', 'size', 'location', 'rent', 'status', 'notes', 'locker_type_id', 'unit_id'];
  for (const key of allowed) {
    if (d[key] !== undefined) { fields.push(`${key} = ?`); vals.push(d[key]); }
  }
  if (fields.length === 0) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE lockers SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  logInfo('Locker updated', { id: req.params.id, fields: Object.keys(d).filter(k => allowed.includes(k)) });
  res.json({ ok: true });
});

app.delete('/api/lockers/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  const occupant = db.prepare("SELECT id, name FROM tenants WHERE locker_id = ? AND (account_status IS NULL OR account_status != 'Closed')").get(req.params.id);
  if (occupant) {
    return res.status(400).json({ error: `Cannot delete — locker is assigned to ${occupant.name}. Close or reassign the tenant first.` });
  }
  db.prepare('DELETE FROM lockers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  ROOM LAYOUTS (Floor Plan Builder)
// ============================

// Get room layout for a branch
app.get('/api/branches/:id/room-layout', requireAuth, (req, res) => {
  try {
    const layout = db.prepare('SELECT * FROM room_layouts WHERE branch_id = ?').get(req.params.id);
    if (!layout) return res.json({ status: 'none' });
    // Parse JSON fields
    layout.room_polygon = JSON.parse(layout.room_polygon || '[]');
    layout.room_elements = JSON.parse(layout.room_elements || '[]');
    layout.unit_placements = JSON.parse(layout.unit_placements || '{}');
    res.json(layout);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save/update room layout (root/headoffice only for edits after initial setup)
app.put('/api/branches/:id/room-layout', requireAuth, requireRole('headoffice'), (req, res) => {
  try {
    const d = req.body;
    const existing = db.prepare('SELECT * FROM room_layouts WHERE branch_id = ?').get(req.params.id);

    // If layout already exists and is active, only superuser (root) can edit
    if (existing && existing.status === 'active') {
      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
      if (!user || user.role !== 'headoffice') {
        return res.status(403).json({ error: 'Only root user can modify an active room layout' });
      }
      // Additional check: is this the superuser (first HO user)?
      const superUser = db.prepare("SELECT id FROM users WHERE role = 'headoffice' ORDER BY created_at ASC LIMIT 1").get();
      if (superUser && superUser.id !== req.user.id) {
        return res.status(403).json({ error: 'Only the root admin can modify an active room layout' });
      }
    }

    const polygon = JSON.stringify(d.room_polygon || []);
    const elements = JSON.stringify(d.room_elements || []);
    const placements = JSON.stringify(d.unit_placements || {});
    const width = d.room_width_ft || 20;
    const height = d.room_height_ft || 15;
    const status = d.status || 'configured';

    if (existing) {
      db.prepare(`UPDATE room_layouts SET room_polygon = ?, room_elements = ?, unit_placements = ?,
        room_width_ft = ?, room_height_ft = ?, status = ?, updated_at = datetime('now') WHERE branch_id = ?`).run(
        polygon, elements, placements, width, height, status, req.params.id
      );
    } else {
      const id = genId();
      db.prepare(`INSERT INTO room_layouts (id, branch_id, room_polygon, room_elements, unit_placements,
        room_width_ft, room_height_ft, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, req.params.id, polygon, elements, placements, width, height, status, req.user.id
      );
    }

    logInfo('Room layout saved', { branch_id: req.params.id, status });
    res.json({ ok: true });
  } catch (err) {
    logError('Room layout save failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get units with locker details for the room view
app.get('/api/branches/:id/room-units', requireAuth, (req, res) => {
  try {
    const units = db.prepare(`SELECT u.*, lt.name as type_name, lt.variant as type_variant,
      lt.lockers_per_unit, lt.unit_width_mm, lt.unit_depth_mm, lt.unit_height_mm,
      lt.annual_rent as type_annual_rent, lt.deposit as type_deposit
      FROM units u JOIN locker_types lt ON u.locker_type_id = lt.id
      WHERE u.branch_id = ? ORDER BY u.unit_number`).all(req.params.id);

    // For each unit, get lockers with tenant info
    const getLockers = db.prepare(`SELECT l.id, l.number, l.size, l.status, l.rent,
      t.name as tenant_name, t.phone as tenant_phone, t.bg_status
      FROM lockers l LEFT JOIN tenants t ON t.locker_id = l.id
      WHERE l.unit_id = ? ORDER BY l.number`);

    const result = units.map(u => {
      const lockers = getLockers.all(u.id);
      const occupied = lockers.filter(l => l.status === 'occupied').length;
      const vacant = lockers.filter(l => l.status === 'vacant').length;
      return { ...u, lockers, occupied, vacant, total: lockers.length };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
//  TENANTS
// ============================
app.get('/api/tenants', requireAuth, enforceBranchScope, (req, res) => {
  const { branch_id } = req.query;
  let tenants;
  if (branch_id && branch_id !== 'all') {
    tenants = db.prepare(`SELECT t.*, l.number as locker_number FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id WHERE t.branch_id = ? ORDER BY t.name`).all(branch_id);
  } else {
    tenants = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id JOIN branches b ON t.branch_id = b.id ORDER BY b.name, t.name`).all();
  }
  res.json(tenants);
});

app.post('/api/tenants', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  try {
    const d = req.body;
    if (!d.name || !d.name.trim()) return res.status(400).json({ error: 'Tenant name is required' });
    if (!d.branch_id) return res.status(400).json({ error: 'Branch is required' });
    // Sanitize phone, Aadhaar, PAN
    if (d.phone) d.phone = d.phone.replace(/[^0-9]/g, '').slice(0, 10);
    if (d.bg_aadhaar) d.bg_aadhaar = d.bg_aadhaar.replace(/[^0-9]/g, '').slice(0, 12);
    if (d.bg_pan) d.bg_pan = d.bg_pan.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (d.nominee_aadhaar) d.nominee_aadhaar = d.nominee_aadhaar.replace(/[^0-9]/g, '').slice(0, 12);
    if (d.nominee_pan) d.nominee_pan = d.nominee_pan.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (d.nominee_phone) d.nominee_phone = d.nominee_phone.replace(/[^0-9]/g, '').slice(0, 10);
    // Check locker availability
    if (d.locker_id) {
      const existingTenant = db.prepare("SELECT id, name FROM tenants WHERE locker_id = ?").get(d.locker_id);
      if (existingTenant) return res.status(400).json({ error: `Locker is already assigned to ${existingTenant.name}` });
    }

    const txResult = db.transaction(() => {
      const id = genId();
      // Auto-calculate lease_end (365 days from lease_start)
      let lease_end = d.lease_end || '';
      if (!lease_end && d.lease_start) {
        const start = new Date(d.lease_start);
        start.setFullYear(start.getFullYear() + 1);
        lease_end = start.toISOString().split('T')[0];
      }
      db.prepare(`INSERT INTO tenants (id, branch_id, name, phone, email, address, emergency_name, emergency, locker_id, lease_start, lease_end,
        annual_rent, deposit, bank_name, bank_account, bank_ifsc, bank_branch,
        bg_aadhaar, bg_pan, bg_photos_collected, bg_status, bg_notes,
        nominee_name, nominee_phone, nominee_aadhaar, nominee_pan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, d.branch_id, d.name, d.phone || '', d.email || '', d.address || '', d.emergency_name || '', d.emergency || '', d.locker_id || '', d.lease_start || '', lease_end,
        d.annual_rent || 0, d.deposit || 0, d.bank_name || '', d.bank_account || '', d.bank_ifsc || '', d.bank_branch || '',
        d.bg_aadhaar || '', d.bg_pan || '', d.bg_photos_collected ? 1 : 0, d.bg_status || 'Pending', d.bg_notes || '',
        d.nominee_name || '', d.nominee_phone || '', d.nominee_aadhaar || '', d.nominee_pan || ''
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
      return { id, lease_end, annual_rent: d.annual_rent || 0, deposit: d.deposit || 0 };
    })();

    res.json(txResult);
  } catch (err) {
    logError('Error creating tenant', { error: err.message, name: req.body.name });
    res.status(500).json({ error: err.message });
  }
});

// Lookup tenant by phone (for staff booking) — MUST be before /:id route
app.get('/api/tenants/by-phone/:phone', requireAuth, (req, res) => {
  const tenant = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name
    FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
    LEFT JOIN branches b ON t.branch_id = b.id
    WHERE t.phone = ?`).get(req.params.phone);
  if (!tenant) return res.status(404).json({ error: 'No tenant found with this phone number' });
  res.json(tenant);
});

app.get('/api/tenants/:id', requireAuth, (req, res) => {
  const tenant = db.prepare(`SELECT t.*, l.number as locker_number FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id WHERE t.id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json(tenant);
});

app.put('/api/tenants/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  try {
    const d = req.body;
    // Sanitize nominee fields
    if (d.nominee_aadhaar) d.nominee_aadhaar = d.nominee_aadhaar.replace(/[^0-9]/g, '').slice(0, 12);
    if (d.nominee_pan) d.nominee_pan = d.nominee_pan.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (d.nominee_phone) d.nominee_phone = d.nominee_phone.replace(/[^0-9]/g, '').slice(0, 10);
    // Handle locker status changes
    const oldTenant = db.prepare('SELECT locker_id FROM tenants WHERE id = ?').get(req.params.id);
    const oldLockerId = oldTenant ? oldTenant.locker_id : '';
    const newLockerId = d.locker_id || '';

    if (oldLockerId !== newLockerId) {
      // Check if new locker is already occupied by another tenant
      if (newLockerId) {
        const existingTenant = db.prepare("SELECT id, name FROM tenants WHERE locker_id = ? AND id != ?").get(newLockerId, req.params.id);
        if (existingTenant) {
          return res.status(400).json({ error: `Locker is already assigned to ${existingTenant.name}` });
        }
      }
      // Free old locker
      if (oldLockerId) db.prepare("UPDATE lockers SET status = 'vacant' WHERE id = ?").run(oldLockerId);
      // Occupy new locker
      if (newLockerId) db.prepare("UPDATE lockers SET status = 'occupied' WHERE id = ?").run(newLockerId);
      logInfo('Locker reassigned', { tenant: req.params.id, from: oldLockerId, to: newLockerId });
    }

    // Auto-compute bg_status based on ALL verification criteria
    {
      const existing = db.prepare('SELECT bg_aadhaar, bg_pan, nominee_name, nominee_phone, nominee_aadhaar, nominee_pan, kyc_documents FROM tenants WHERE id = ?').get(req.params.id);
      if (existing) {
        const merged = {
          bg_aadhaar: d.bg_aadhaar !== undefined ? d.bg_aadhaar : existing.bg_aadhaar,
          bg_pan: d.bg_pan !== undefined ? d.bg_pan : existing.bg_pan,
          nominee_name: d.nominee_name !== undefined ? d.nominee_name : existing.nominee_name,
          nominee_phone: d.nominee_phone !== undefined ? d.nominee_phone : existing.nominee_phone,
          nominee_aadhaar: d.nominee_aadhaar !== undefined ? d.nominee_aadhaar : existing.nominee_aadhaar,
          nominee_pan: d.nominee_pan !== undefined ? d.nominee_pan : existing.nominee_pan,
          kyc_documents: existing.kyc_documents // KYC docs updated via separate upload endpoint
        };
        d.bg_status = computeBgStatus(merged);
      }
    }

    const allowedFields = ['name', 'phone', 'email', 'address', 'emergency_name', 'emergency', 'locker_id', 'lease_start', 'lease_end', 'annual_rent', 'deposit', 'bank_name', 'bank_account', 'bank_ifsc', 'bank_branch', 'bg_aadhaar', 'bg_pan', 'bg_photos_collected', 'bg_status', 'bg_notes', 'customer_password', 'account_status', 'nominee_name', 'nominee_phone', 'nominee_aadhaar', 'nominee_pan'];
    const fields = [];
    const vals = [];
    for (const [k, v] of Object.entries(d)) {
      if (!allowedFields.includes(k)) continue;
      fields.push(`${k} = ?`);
      // SQLite does not accept JS booleans — convert to 1/0
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (fields.length) {
      vals.push(req.params.id);
      db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }
    res.json({ ok: true });
  } catch (err) {
    logError('Error updating tenant', { id: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── KYC Document Upload ─────────────────────────────────────────
// Upload a KYC document for a tenant to SharePoint → LockerHub → KYC → {Branch} → {TenantName} → {Customer|Nominee}
app.post('/api/tenants/:id/kyc-upload', requireAuth, requireRole('headoffice', 'branch'), kycUpload.single('file'), async (req, res) => {
  try {
    const tenant = db.prepare('SELECT t.*, b.name as branch_name FROM tenants t JOIN branches b ON t.branch_id = b.id WHERE t.id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const docType = req.body.doc_type; // e.g. 'customer_aadhaar_front', 'nominee_pan'
    const validDocTypes = [
      'customer_aadhaar_front', 'customer_aadhaar_back', 'customer_pan',
      'nominee_aadhaar_front', 'nominee_aadhaar_back', 'nominee_pan'
    ];
    if (!docType || !validDocTypes.includes(docType)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }

    // Determine subfolder: KYC/{BranchName}/{TenantName}/{Customer or Nominee}
    const isNominee = docType.startsWith('nominee_');
    const personFolder = isNominee ? 'Nominee' : 'Customer';
    const safeBranch = tenant.branch_name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
    const safeTenant = tenant.name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
    const subfolder = `KYC/${safeBranch}/${safeTenant}/${personFolder}`;

    // Build filename: DocType_TenantName.ext
    const ext = path.extname(req.file.originalname) || '.jpg';
    const docLabel = docType.replace('customer_', '').replace('nominee_', '');
    const fileName = `${docLabel}${ext}`;

    // Upload to SharePoint
    const sharePointUrl = await uploadToSharePoint(
      req.file.buffer,
      fileName,
      subfolder,
      req.file.mimetype
    );

    // Update kyc_documents JSON in DB
    let kycDocs = {};
    try { kycDocs = JSON.parse(tenant.kyc_documents || '{}'); } catch(e) {}
    kycDocs[docType] = {
      uploaded: true,
      filename: req.file.originalname,
      sharepoint_url: sharePointUrl,
      uploaded_at: new Date().toISOString(),
      mimetype: req.file.mimetype
    };
    const updatedKycJson = JSON.stringify(kycDocs);
    db.prepare('UPDATE tenants SET kyc_documents = ? WHERE id = ?').run(updatedKycJson, req.params.id);

    // Recompute bg_status after KYC upload
    const updatedTenant = db.prepare('SELECT bg_aadhaar, bg_pan, nominee_name, nominee_phone, nominee_aadhaar, nominee_pan FROM tenants WHERE id = ?').get(req.params.id);
    if (updatedTenant) {
      updatedTenant.kyc_documents = updatedKycJson;
      const newStatus = computeBgStatus(updatedTenant);
      db.prepare('UPDATE tenants SET bg_status = ? WHERE id = ?').run(newStatus, req.params.id);
    }

    logInfo('KYC document uploaded', { tenantId: req.params.id, docType, sharePointUrl });
    res.json({ ok: true, doc_type: docType, sharepoint_url: sharePointUrl });
  } catch (err) {
    logError('KYC upload failed', { tenantId: req.params.id, error: err.message || JSON.stringify(err) });
    res.status(500).json({ error: 'Upload failed: ' + (err.message || 'Unknown error') });
  }
});

// Get KYC document status for a tenant
app.get('/api/tenants/:id/kyc-status', requireAuth, (req, res) => {
  try {
    const tenant = db.prepare('SELECT kyc_documents, nominee_name, nominee_phone, nominee_aadhaar, nominee_pan FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    let kycDocs = {};
    try { kycDocs = JSON.parse(tenant.kyc_documents || '{}'); } catch(e) {}
    res.json({
      kyc_documents: kycDocs,
      nominee_name: tenant.nominee_name,
      nominee_phone: tenant.nominee_phone,
      nominee_aadhaar: tenant.nominee_aadhaar,
      nominee_pan: tenant.nominee_pan
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Close tenant account (soft delete — preserves records for audit)
app.post('/api/tenants/:id/close', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  try {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (tenant.account_status === 'Closed') return res.status(400).json({ error: 'Account is already closed' });

    const reason = req.body.reason || '';

    db.transaction(() => {
      // Free the locker
      if (tenant.locker_id) {
        db.prepare("UPDATE lockers SET status = 'vacant' WHERE id = ?").run(tenant.locker_id);
      }
      // Update tenant: clear locker, set closed status
      db.prepare("UPDATE tenants SET account_status = 'Closed', closed_at = datetime('now'), closed_reason = ?, locker_id = '' WHERE id = ?").run(reason, req.params.id);
      logInfo('Tenant account closed', { id: req.params.id, name: tenant.name, locker_freed: tenant.locker_id, reason });
    })();

    res.json({ ok: true, message: 'Account closed. Locker has been freed.' });
  } catch (err) {
    logError('Account close failed', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to close account' });
  }
});

// Reopen a closed tenant account
app.post('/api/tenants/:id/reopen', requireAuth, requireRole('headoffice'), (req, res) => {
  try {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (tenant.account_status !== 'Closed') return res.status(400).json({ error: 'Account is not closed' });
    db.prepare("UPDATE tenants SET account_status = 'Active', closed_at = '', closed_reason = '' WHERE id = ?").run(req.params.id);
    logInfo('Tenant account reopened', { id: req.params.id, name: tenant.name });
    res.json({ ok: true });
  } catch (err) {
    logError('Account reopen failed', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to reopen account' });
  }
});

app.delete('/api/tenants/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  try {
    const tenant = db.prepare('SELECT locker_id, name FROM tenants WHERE id = ?').get(req.params.id);
    if (tenant && tenant.locker_id) {
      db.prepare("UPDATE lockers SET status = 'vacant' WHERE id = ?").run(tenant.locker_id);
    }
    // Clean up related records (must delete all child records before tenant due to foreign keys)
    const delPayments = db.prepare('DELETE FROM payments WHERE tenant_id = ?').run(req.params.id);
    const delPayouts = db.prepare('DELETE FROM payouts WHERE tenant_id = ?').run(req.params.id);
    const delVisits = db.prepare('DELETE FROM visits WHERE tenant_id = ?').run(req.params.id);
    const delAppointments = db.prepare('DELETE FROM appointments WHERE tenant_id = ?').run(req.params.id);
    const delEsign = db.prepare('DELETE FROM esign_requests WHERE tenant_id = ?').run(req.params.id);
    const delFeedback = db.prepare('DELETE FROM feedback WHERE tenant_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);
    logWarn('Tenant deleted', { id: req.params.id, name: tenant ? tenant.name : '', payments_removed: delPayments.changes, payouts_removed: delPayouts.changes, visits_removed: delVisits.changes, appointments_removed: delAppointments.changes, esign_removed: delEsign.changes, feedback_removed: delFeedback.changes });
    res.json({ ok: true });
  } catch (err) {
    logWarn('Tenant delete failed', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to delete tenant: ' + err.message });
  }
});

// ============================
//  STATEMENT OF ACCOUNT (SOA)
// ============================
app.get('/api/soa/:id', requireAuth, (req, res) => {
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
app.get('/api/allotment-form/:id', requireAuth, async (req, res) => {
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

    // Auto-generate agreement number: DFIN/branch-short/YYYY/seq
    const branchShort = (branch && branch.name ? branch.name.replace(/\s+/g, '').substring(0, 4).toUpperCase() : 'HQ');
    const year = new Date(tenant.lease_start || tenant.created_at || Date.now()).getFullYear();
    const tenantSeq = db.prepare('SELECT COUNT(*) as cnt FROM tenants WHERE branch_id = ? AND created_at <= ?').get(tenant.branch_id, tenant.created_at || new Date().toISOString());
    const seqNum = String((tenantSeq ? tenantSeq.cnt : 1)).padStart(4, '0');
    const agreementNo = `DFIN/${branchShort}/${year}/${seqNum}`;

    // Get payment records for this tenant
    const payments = db.prepare('SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at ASC').all(req.params.id);
    const depositPayment = payments.find(p => p.type === 'deposit');
    const rentPayment = payments.find(p => p.type === 'rent');

    // Attach computed fields to tenant — only show PAID amounts on the form
    tenant.agreement_no = agreementNo;
    tenant.allotment_date = tenant.lease_start || new Date().toISOString().split('T')[0];
    const paidDeposit = payments.find(p => p.type === 'deposit' && p.status === 'Paid');
    const paidRent = payments.find(p => p.type === 'rent' && p.status === 'Paid');
    tenant.deposit_amount = paidDeposit ? paidDeposit.amount : 0;
    tenant.rent_amount = paidRent ? paidRent.amount : 0;

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
//  PAYMENT RECEIPT PDF
// ============================
app.get('/api/receipt/:paymentId', requireAuth, async (req, res) => {
  try {
    const payment = db.prepare(`SELECT p.*, t.name as tenant_name, t.phone as tenant_phone,
      l.number as locker_number, l.size as locker_size
      FROM payments p
      LEFT JOIN tenants t ON p.tenant_id = t.id
      LEFT JOIN lockers l ON p.locker_id = l.id
      WHERE p.id = ?`).get(req.params.paymentId);

    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(payment.branch_id);
    const tenant = { name: payment.tenant_name, phone: payment.tenant_phone, locker_number: payment.locker_number };
    const locker = { number: payment.locker_number, size: payment.locker_size };

    const customerOnly = req.query.copy === 'customer';
    const pdfBuffer = await generateReceiptBuffer(payment, tenant, branch || {}, locker || {}, { customerOnly });

    const safeName = (payment.receipt_no || 'receipt').replace(/[^a-zA-Z0-9-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Receipt_${safeName}.pdf`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Receipt generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================
//  PAYMENTS
// ============================
app.get('/api/payments', requireAuth, enforceBranchScope, (req, res) => {
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

app.get('/api/payments/:id', requireAuth, (req, res) => {
  const payment = db.prepare(`SELECT p.*, t.name as tenant_name, l.number as locker_number
    FROM payments p LEFT JOIN tenants t ON p.tenant_id = t.id LEFT JOIN lockers l ON p.locker_id = l.id
    WHERE p.id = ?`).get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  res.json(payment);
});

app.post('/api/payments', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  try {
  const d = req.body;
  if (!d.branch_id) return res.status(400).json({ error: 'Branch is required' });
  if (!d.tenant_id) return res.status(400).json({ error: 'Tenant is required' });
  if (!d.amount || isNaN(parseFloat(d.amount)) || parseFloat(d.amount) <= 0) return res.status(400).json({ error: 'Amount must be a valid number greater than 0' });
  const type = d.type || 'rent';
  if (!['rent', 'deposit', 'penalty', 'other'].includes(type)) return res.status(400).json({ error: 'Invalid payment type' });

  // Auto-fill paid_on when marking as Paid
  if (d.status === 'Paid' && !d.paid_on) d.paid_on = new Date().toISOString().split('T')[0];

  // Auto-fill locker_id from tenant if not provided
  let locker_id = d.locker_id || '';
  if (!locker_id && d.tenant_id) {
    const tenant = db.prepare('SELECT locker_id FROM tenants WHERE id = ?').get(d.tenant_id);
    if (tenant) locker_id = tenant.locker_id || '';
  }

  // Check if there's an existing Pending/Overdue payment for the same tenant+type to update instead of duplicate
  const existingPending = d.tenant_id ? db.prepare(
    "SELECT id, receipt_no FROM payments WHERE tenant_id = ? AND type = ? AND (status = 'Pending' OR status = 'Overdue') LIMIT 1"
  ).get(d.tenant_id, type) : null;

  if (existingPending) {
    // Update the existing pending record instead of creating a duplicate
    db.prepare(`UPDATE payments SET locker_id = ?, period = ?, amount = ?, due_date = ?, status = ?, paid_on = ?, method = ?, ref_no = ?, notes = ? WHERE id = ?`).run(
      locker_id, d.period || '', d.amount || 0, d.due_date || '', d.status || 'Pending', d.paid_on || '', d.method || '', d.ref_no || '', d.notes || '', existingPending.id
    );
    logInfo('Payment updated (matched pending)', { id: existingPending.id, receipt_no: existingPending.receipt_no, type, tenant: d.tenant_id, amount: d.amount, status: d.status });
    res.json({ id: existingPending.id, receipt_no: existingPending.receipt_no, updated: true });
  } else {
    // No pending match — create a new payment record
    const id = genId();
    const receipt_no = d.receipt_no || getNextReceiptNo();
    db.prepare('INSERT INTO payments (id, branch_id, tenant_id, locker_id, type, period, amount, due_date, status, paid_on, method, ref_no, receipt_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, d.branch_id, d.tenant_id, locker_id, type, d.period || '', d.amount || 0, d.due_date || '', d.status || 'Pending', d.paid_on || '', d.method || '', d.ref_no || '', receipt_no, d.notes || ''
    );
    logInfo('Payment recorded', { id, receipt_no, type, tenant: d.tenant_id, amount: d.amount, period: d.period, status: d.status });
    res.json({ id, receipt_no });
  }
  } catch (err) {
    logError('Payment creation failed', { error: err.message, tenant: req.body.tenant_id });
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

app.put('/api/payments/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  try {
    const d = req.body;
    if (d.status && !['Pending', 'Overdue', 'Paid'].includes(d.status)) {
      return res.status(400).json({ error: 'Invalid payment status. Must be Pending, Overdue, or Paid.' });
    }
    if (d.amount !== undefined && (isNaN(parseFloat(d.amount)) || parseFloat(d.amount) <= 0)) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    const allowedFields = ['tenant_id', 'locker_id', 'type', 'period', 'amount', 'due_date', 'status', 'paid_on', 'method', 'ref_no', 'receipt_no', 'notes'];
    const fields = []; const vals = [];
    for (const [k, v] of Object.entries(d)) {
      if (!allowedFields.includes(k)) continue;
      fields.push(`${k} = ?`);
      vals.push(v);
    }
    // Auto-fill paid_on when marking as Paid
    if (d.status === 'Paid' && !d.paid_on) {
      fields.push('paid_on = ?');
      vals.push(new Date().toISOString().split('T')[0]);
    }
    if (fields.length) {
      vals.push(req.params.id);
      db.prepare(`UPDATE payments SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }
    res.json({ ok: true });
  } catch (err) {
    logError('Payment update failed', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to update payment' });
  }
});

app.delete('/api/payments/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment record not found' });
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  logWarn('Payment deleted', { id: req.params.id, receipt: payment.receipt_no, amount: payment.amount });
  res.json({ ok: true });
});

// ============================
//  RENT SCHEDULE GENERATION
// Mark overdue payments automatically (annual rent: overdue if due_date passed)
app.post('/api/payments/check-overdue', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
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
app.get('/api/renewals', requireAuth, enforceBranchScope, (req, res) => {
  try {
    const { branch_id } = req.query;
    const today = new Date().toISOString().split('T')[0];
    // Get tenants whose lease_end is within 90 days or already past
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 90);
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

// Customer-facing lease reminder
app.get('/api/customer/:tenantId/reminders', requireAuth, (req, res) => {
  try {
    const tenants = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name
      FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
      LEFT JOIN branches b ON t.branch_id = b.id
      WHERE t.id = ? AND t.lease_end != ''`).all(req.params.tenantId);

    // Also check by phone for multi-branch customers
    if (tenants.length === 0) {
      const tenant = db.prepare('SELECT phone FROM tenants WHERE id = ?').get(req.params.tenantId);
      if (tenant && tenant.phone) {
        const byPhone = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name
          FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
          LEFT JOIN branches b ON t.branch_id = b.id
          WHERE t.phone = ? AND t.lease_end != ''`).all(tenant.phone);
        tenants.push(...byPhone);
      }
    }

    const today = new Date();
    const reminders = tenants.map(t => {
      const leaseEnd = new Date(t.lease_end);
      const daysLeft = Math.ceil((leaseEnd - today) / (1000 * 60 * 60 * 24));
      return { ...t, days_left: daysLeft, is_expired: daysLeft < 0 };
    }).filter(t => t.days_left <= 90); // Only show if within 90 days or expired

    res.json(reminders);
  } catch (err) {
    logError('Customer reminders error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Renew a tenant's lease (extend by 1 year)
app.post('/api/renewals/:id/renew', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
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
app.get('/api/payouts', requireAuth, enforceBranchScope, (req, res) => {
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

app.post('/api/payouts', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const d = req.body;
  const id = genId();
  db.prepare('INSERT INTO payouts (id, branch_id, tenant_id, locker_id, period, rate, principal, amount, due_date, status, paid_on, method, ref_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, d.branch_id, d.tenant_id, d.locker_id || '', d.period || '', d.rate || 0, d.principal || 0, d.amount || 0, d.due_date || '', d.status || 'Pending', d.paid_on || '', d.method || '', d.ref_no || '', d.notes || ''
  );
  res.json({ id });
});

app.put('/api/payouts/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const d = req.body;
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries(d)) { if (k === 'id' || k === 'branch_id') continue; fields.push(`${k} = ?`); vals.push(v); }
  if (fields.length) { vals.push(req.params.id); db.prepare(`UPDATE payouts SET ${fields.join(', ')} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});

// ============================
//  VISITS
// ============================
app.get('/api/visits', requireAuth, enforceBranchScope, (req, res) => {
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

app.post('/api/visits', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const d = req.body;
  const id = genId();
  db.prepare('INSERT INTO visits (id, branch_id, tenant_id, locker_id, datetime, purpose, duration, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, d.branch_id, d.tenant_id, d.locker_id || '', d.datetime || '', d.purpose || '', d.duration || '', d.notes || ''
  );
  res.json({ id });
});

app.put('/api/visits/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const d = req.body;
  const allowedFields = ['branch_id', 'tenant_id', 'locker_id', 'datetime', 'purpose', 'duration', 'notes'];
  const fields = []; const vals = [];
  for (const [k, v] of Object.entries(d)) {
    if (!allowedFields.includes(k)) continue;
    fields.push(`${k} = ?`);
    vals.push(v);
  }
  if (fields.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE visits SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  res.json({ ok: true });
});

app.delete('/api/visits/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  db.prepare('DELETE FROM visits WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================
//  ACTIVITY LOG
// ============================
app.get('/api/activities', requireAuth, enforceBranchScope, (req, res) => {
  const { branch_id } = req.query;
  let activities;
  if (branch_id && branch_id !== 'all') {
    activities = db.prepare('SELECT a.*, b.name as branch_name FROM activities a JOIN branches b ON a.branch_id = b.id WHERE a.branch_id = ? ORDER BY a.created_at DESC LIMIT 50').all(branch_id);
  } else {
    activities = db.prepare('SELECT a.*, b.name as branch_name FROM activities a JOIN branches b ON a.branch_id = b.id ORDER BY a.created_at DESC LIMIT 100').all();
  }
  res.json(activities);
});

app.post('/api/activities', requireAuth, (req, res) => {
  const { branch_id, message } = req.body;
  db.prepare('INSERT INTO activities (branch_id, message) VALUES (?, ?)').run(branch_id, message);
  res.json({ ok: true });
});

// ============================
//  CONFIG
// ============================
app.get('/api/config/:branch_id', requireAuth, (req, res) => {
  let config = db.prepare('SELECT * FROM config WHERE branch_id = ?').get(req.params.branch_id);
  if (!config) config = { rate: 8, freq: 'monthly', calc_on: 'rent_paid' };
  res.json(config);
});

app.put('/api/config/:branch_id', requireAuth, requireRole('headoffice'), (req, res) => {
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
app.get('/api/stats', requireAuth, enforceBranchScope, (req, res) => {
  const { branch_id } = req.query;
  if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
  const lockers = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='occupied' THEN 1 ELSE 0 END) as occupied, SUM(CASE WHEN status='vacant' THEN 1 ELSE 0 END) as vacant FROM lockers WHERE branch_id = ?`).get(branch_id);
  const revenue = db.prepare(`SELECT COALESCE(SUM(annual_rent), 0) as total FROM tenants WHERE branch_id = ? AND locker_id != '' AND (account_status IS NULL OR account_status != 'Closed')`).get(branch_id);
  const tenantCount = db.prepare(`SELECT COUNT(*) as total FROM tenants WHERE branch_id = ? AND (account_status IS NULL OR account_status != 'Closed')`).get(branch_id);
  const overdue = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Overdue'`).get(branch_id);
  const missedPayouts = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payouts WHERE branch_id = ? AND status = 'Missed'`).get(branch_id);

  // Separate rent collected vs deposit collected
  const rentCollected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND type = 'rent'`).get(branch_id);
  const depositCollected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND type = 'deposit'`).get(branch_id);
  const totalCollected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid'`).get(branch_id);
  const totalPending = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Pending'`).get(branch_id);

  const todayVisits = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE branch_id = ? AND date(datetime) = date('now')`).get(branch_id);
  const unverified = db.prepare(`SELECT COUNT(*) as count FROM tenants WHERE branch_id = ? AND bg_status != 'Verified' AND bg_status != 'verified' AND (account_status IS NULL OR account_status != 'Closed')`).get(branch_id);
  const pendingInterest = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payouts WHERE branch_id = ? AND (status = 'Pending' OR status = 'Missed')`).get(branch_id);

  // Current month summary — match by paid_on date (YYYY-MM-DD), not period
  const now = new Date();
  const currentMonth = now.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const yearMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const monthPaid = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND paid_on LIKE ?`).get(branch_id, yearMonth + '%');
  const monthPending = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Pending'`).get(branch_id);
  const monthOverdue = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Overdue'`).get(branch_id);

  res.json({
    total_lockers: lockers.total || 0, occupied: lockers.occupied || 0, vacant: lockers.vacant || 0,
    occupancy_pct: lockers.total ? Math.round((lockers.occupied || 0) / lockers.total * 100) : 0,
    annual_revenue: revenue.total, monthly_revenue: Math.round(revenue.total / 12),
    tenants: tenantCount.total,
    overdue_count: overdue.count, overdue_amount: overdue.total,
    missed_payouts: missedPayouts.count, missed_payout_amount: missedPayouts.total,
    collected: totalCollected.total, rent_collected: rentCollected.total, deposit_collected: depositCollected.total,
    pending_count: totalPending.count, pending_amount: totalPending.total,
    today_visits: todayVisits.count,
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
app.get('/api/stats/all', requireAuth, requireRole('headoffice'), (req, res) => {
  const branches = db.prepare('SELECT * FROM branches ORDER BY name').all();
  const now = new Date();
  const yearMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const stats = branches.map(b => {
    const lockers = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='occupied' THEN 1 ELSE 0 END) as occupied, SUM(CASE WHEN status='vacant' THEN 1 ELSE 0 END) as vacant FROM lockers WHERE branch_id = ?`).get(b.id);
    const revenue = db.prepare(`SELECT COALESCE(SUM(annual_rent), 0) as total FROM tenants WHERE branch_id = ? AND locker_id != ''`).get(b.id);
    const tenants = db.prepare(`SELECT COUNT(*) as total FROM tenants WHERE branch_id = ?`).get(b.id);
    const overdue = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Overdue'`).get(b.id);
    const missedPayouts = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payouts WHERE branch_id = ? AND status = 'Missed'`).get(b.id);
    const rentCollected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND type = 'rent'`).get(b.id);
    const depositCollected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND type = 'deposit'`).get(b.id);
    const totalCollected = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid'`).get(b.id);
    const totalPending = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Pending'`).get(b.id);
    const todayVisits = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE branch_id = ? AND date(datetime) = date('now')`).get(b.id);
    const unverified = db.prepare(`SELECT COUNT(*) as count FROM tenants WHERE branch_id = ? AND bg_status != 'Verified' AND bg_status != 'verified'`).get(b.id);
    const monthPaid = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE branch_id = ? AND status = 'Paid' AND paid_on LIKE ?`).get(b.id, yearMonth + '%');

    return {
      branch_id: b.id, branch_name: b.name,
      total_lockers: lockers.total || 0, occupied: lockers.occupied || 0, vacant: lockers.vacant || 0,
      occupancy: lockers.total ? Math.round((lockers.occupied || 0) / lockers.total * 100) : 0,
      occupancy_pct: lockers.total ? Math.round((lockers.occupied || 0) / lockers.total * 100) : 0,
      annual_revenue: revenue.total, tenants: tenants.total,
      overdue_count: overdue.count, overdue_amount: overdue.total,
      missed_payouts: missedPayouts.count, missed_payout_amount: missedPayouts.total,
      collected: totalCollected.total, rent_collected: rentCollected.total, deposit_collected: depositCollected.total,
      pending_count: totalPending.count, pending_amount: totalPending.total,
      today_visits: todayVisits.count,
      unverified_tenants: unverified.count,
      month_paid: monthPaid.count, month_paid_amount: monthPaid.total
    };
  });
  res.json(stats);
});

// ============================
//  BACKUP & RESTORE
// ============================
app.get('/api/backup', requireAuth, requireRole('headoffice'), (req, res) => {
  try {
    const backup = {
      version: 6,
      export_date: new Date().toISOString(),
      branches: db.prepare('SELECT * FROM branches').all(),
      users: db.prepare('SELECT id, username, name, role, branch_id, created_at FROM users').all(),
      locker_types: db.prepare('SELECT * FROM locker_types').all(),
      units: db.prepare('SELECT * FROM units').all(),
      lockers: db.prepare('SELECT * FROM lockers').all(),
      tenants: db.prepare('SELECT id, branch_id, name, phone, email, address, emergency_name, emergency, locker_id, lease_start, lease_end, annual_rent, deposit, bank_name, bank_account, bank_ifsc, bank_branch, bg_aadhaar, bg_pan, bg_photos_collected, bg_status, bg_notes, account_status, closed_at, closed_reason, nominee_name, nominee_phone, nominee_aadhaar, nominee_pan, kyc_documents, created_at FROM tenants').all(),
      payments: db.prepare('SELECT * FROM payments').all(),
      payouts: db.prepare('SELECT * FROM payouts').all(),
      appointments: db.prepare('SELECT * FROM appointments').all(),
      visits: db.prepare('SELECT * FROM visits').all(),
      activities: db.prepare('SELECT * FROM activities').all(),
      config: db.prepare('SELECT * FROM config').all(),
      esign_requests: db.prepare('SELECT * FROM esign_requests').all(),
      feedback: db.prepare('SELECT * FROM feedback').all(),
      leads: db.prepare('SELECT * FROM leads').all(),
      lead_notes: db.prepare('SELECT * FROM lead_notes').all(),
      room_layouts: db.prepare('SELECT * FROM room_layouts').all()
    };
    res.json(backup);
  } catch (err) {
    logError('Backup export failed', { error: err.message });
    res.status(500).json({ error: 'Backup export failed: ' + err.message });
  }
});

// ============================
//  USERS MANAGEMENT
// ============================
app.get('/api/users', requireAuth, requireRole('headoffice'), (req, res) => {
  const users = db.prepare('SELECT u.id, u.username, u.name, u.role, u.branch_id, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id = b.id ORDER BY u.role, u.name').all();
  res.json(users);
});

app.post('/api/users', requireAuth, requireRole('headoffice'), async (req, res) => {
  const { username, password, name, role, branch_id } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Username, password, and name are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const id = genId();
  try {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, hashedPassword, name, role || 'branch', branch_id || null);
    logInfo('User created', { id, username, role: role || 'branch' });
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.put('/api/users/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  const { name, role, branch_id, username } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Only root can edit root
  if (user.username === 'root' && req.user.username !== 'root') {
    return res.status(403).json({ error: 'Only the root user can modify the root account' });
  }
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const validRoles = ['headoffice', 'branch', 'lead_agent'];
  if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Prevent changing root's username
  if (user.username === 'root' && username && username !== 'root') {
    return res.status(400).json({ error: 'Cannot change the root username' });
  }
  // Check username uniqueness if changed
  if (username && username !== user.username) {
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = ? AND id != ?').get(username.toLowerCase(), req.params.id);
    if (existing) return res.status(400).json({ error: 'Username already taken' });
  }
  db.prepare('UPDATE users SET name = ?, role = ?, branch_id = ?, username = ? WHERE id = ?').run(
    name.trim(), role || user.role, branch_id || null, username || user.username, req.params.id
  );
  logInfo('User updated', { id: req.params.id, name, role });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireRole('headoffice'), (req, res) => {
  // Protect root user from deletion
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  if (user && user.username === 'root') {
    return res.status(403).json({ error: 'The root account cannot be deleted' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Change Password
app.put('/api/users/:id/password', requireAuth, requireRole('headoffice'), async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  // Only root can change root's password
  const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  if (targetUser && targetUser.username === 'root' && req.user.username !== 'root') {
    return res.status(403).json({ error: 'Only the root user can change the root password' });
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, req.params.id);
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

  // Root super admin
  const rootHash = bcrypt.hashSync('adcc@123', 10);
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    'admin001', 'root', rootHash, 'Root Admin', 'headoffice', null
  );

  // HO admin user
  const hoHash = bcrypt.hashSync('admin@123', 10);
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    genId(), 'ho', hoHash, 'Head Office Admin', 'headoffice', null
  );

  // Google reviewer account
  const reviewerHash = bcrypt.hashSync('Review@2026', 10);
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    genId(), 'googlereviewer', reviewerHash, 'Google Reviewer', 'headoffice', null
  );

  // Lead agent users (for branch opening lead capture)
  const leadAgents = [
    'Guna', 'Nambi', 'Suren', 'Eashwar', 'Pramoth', 'Gowtham', 'Selvakumar',
    'Srinish', 'Harisudhan', 'Rithiesh', 'Gokul', 'Anbu', 'Karthik', 'Deepak',
    'Vignesh', 'Arun', 'Praveen', 'Mohan', 'Rajesh', 'Dinesh'
  ];
  const seedLeadHash = bcrypt.hashSync('lead@123', 10);
  leadAgents.forEach(name => {
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      genId(), name.toLowerCase(), seedLeadHash, name, 'lead_agent', null
    );
  });

  // Locker types — L10 Large: 20k rent, 3L deposit | L6 Medium: 10k rent, 2L deposit
  const types = [
    { id: 'lt_l6_std', name: 'L6', variant: 'Standard', lpu: 6, uh: 2000, uw: 1075, ud: 700, lh: 637, lw: 529, ld: 621, w: 0, up: 0, rent: 10000, dep: 200000, desc: 'L6 Hi-Tech Lockers with Wooden Sleepers' },
    { id: 'lt_l10_std', name: 'L10', variant: 'Standard', lpu: 10, uh: 2000, uw: 1075, ud: 575, lh: 385, lw: 530, ld: 492, w: 475, up: 0, rent: 20000, dep: 300000, desc: 'L2/10 Hi-Tech Lockers with Wooden Sleepers' },
    { id: 'lt_l6_ultra', name: 'L6U', variant: 'Secunex Ultra', lpu: 6, uh: 2000, uw: 1075, ud: 700, lh: 637, lw: 529, ld: 621, w: 0, up: 0, rent: 10000, dep: 200000, desc: 'L6 Secunex Ultra (Silver/Gold facia)' },
    { id: 'lt_l10_ultra', name: 'L10U', variant: 'Secunex Ultra', lpu: 10, uh: 2000, uw: 1075, ud: 575, lh: 385, lw: 530, ld: 492, w: 475, up: 0, rent: 20000, dep: 300000, desc: 'L2/10 Secunex Ultra (Silver/Gold facia)' }
  ];
  const insType = db.prepare(`INSERT INTO locker_types (id, name, variant, lockers_per_unit, unit_height_mm, unit_width_mm, unit_depth_mm, locker_height_mm, locker_width_mm, locker_depth_mm, weight_kg, auto_size, description, is_upcoming, annual_rent, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  types.forEach(t => {
    const sz = classifySize(t.lh, t.lw, t.ld);
    insType.run(t.id, t.name, t.variant, t.lpu, t.uh, t.uw, t.ud, t.lh, t.lw, t.ld, t.w, sz, t.desc, t.up, t.rent, t.dep);
  });

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const insUnit = db.prepare('INSERT INTO units (id, branch_id, locker_type_id, unit_number, location, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insLock = db.prepare('INSERT INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  // ========== RS Puram branch ==========
  const brRS = 'br_rspuram';
  db.prepare('INSERT INTO branches (id, name, address, phone, location, manager_name) VALUES (?, ?, ?, ?, ?, ?)').run(brRS, 'RS Puram', 'RS Puram, Coimbatore', '', 'RS Puram, Coimbatore', '');
  db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(brRS);
  const rsStaffHash = bcrypt.hashSync('admin@123', 10);
  db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    genId(), 'rspuram', rsStaffHash, 'RS Puram Staff', 'branch', brRS
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

  console.log('  ✅ Seeded: root/admin@123 (HO), rspuram/admin@123 (RS Puram, 88 lockers), 20 lead agents');
}
autoSeed();

// ============================
//  DATABASE BACKUP & RESTORE
// ============================
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

app.get('/api/backup/create', requireAuth, requireRole('headoffice'), (req, res) => {
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

app.get('/api/backup/download', requireAuth, requireRole('headoffice'), (req, res) => {
  try {
    const dbPath = path.join(DATA_DIR, 'lockerhub.db');
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: 'Database file not found' });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.download(dbPath, `lockerhub_backup_${timestamp}.db`, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Backup download failed: ' + err.message });
  }
});

app.get('/api/backup/list', requireAuth, requireRole('headoffice'), (req, res) => {
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
// ============================
//  LEGAL: PRIVACY POLICY & TERMS
// ============================
// Public HTML pages for Play Store and Google review
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy - LockerHub by Dhanam</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#2c1810;line-height:1.7;background:#fff8f0}
h1{color:#b8860b;border-bottom:2px solid #b8860b;padding-bottom:12px}h2{color:#2c1810;margin-top:28px}
.meta{color:#888;font-size:14px;margin-bottom:24px}footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font-size:13px;color:#888}</style></head>
<body><h1>Privacy Policy</h1>
<p class="meta">Last updated: 2026-03-30 | Dhanam Investment and Finance Private Limited</p>
<h2>Information We Collect</h2>
<p>We collect personal information including name, phone number, email address, physical address, Aadhaar number (for e-sign verification), PAN number, bank account details (for deposit refunds), and passport-size photographs. This information is necessary for locker rental agreements and identity verification.</p>
<h2>How We Use Your Information</h2>
<p>Your information is used to: manage your locker rental agreement, process payments and deposits, verify your identity for locker access, send appointment confirmations, generate lease agreements, and comply with regulatory requirements.</p>
<h2>Data Storage and Security</h2>
<p>All data is stored on secure servers with encryption. Passwords are hashed using industry-standard bcrypt. API communications are secured with JWT tokens and HTTPS. Sensitive documents are stored in encrypted SharePoint repositories.</p>
<h2>Data Sharing</h2>
<p>We do not sell or share your personal data with third parties except: Digio (for Aadhaar e-sign verification), payment processors, and as required by Indian law enforcement or regulatory authorities.</p>
<h2>Data Retention</h2>
<p>Your data is retained for the duration of your locker rental agreement plus 7 years as required by Indian financial regulations. You may request earlier deletion subject to regulatory requirements.</p>
<h2>Your Rights</h2>
<p>You have the right to: access your data, request corrections, export your data in portable format, and request deletion of your account. These can be done through the app or by contacting support.</p>
<h2>Account Deletion</h2>
<p>You can request deletion of your account and all associated data through the app (Settings → Delete My Account) or by visiting <a href="/delete-account">our account deletion page</a>. Upon request, we will delete your personal data within 30 days, subject to regulatory retention requirements.</p>
<h2>Contact</h2>
<p>For privacy concerns, contact us at: <strong>info@dhanamfinance.com</strong></p>
<p>Dhanam Investment and Finance Private Limited<br>Door No. 22/3, Nehru Nagar, 2nd St, Behind CMS School,<br>Ganapathy, Coimbatore - 641 006, Tamil Nadu, India</p>
<footer>© 2026 Dhanam Investment and Finance Private Limited. All rights reserved.</footer></body></html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terms of Service - LockerHub by Dhanam</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#2c1810;line-height:1.7;background:#fff8f0}
h1{color:#b8860b;border-bottom:2px solid #b8860b;padding-bottom:12px}h2{color:#2c1810;margin-top:28px}
.meta{color:#888;font-size:14px;margin-bottom:24px}footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font-size:13px;color:#888}</style></head>
<body><h1>Terms of Service</h1>
<p class="meta">Last updated: 2026-03-30 | Dhanam Investment and Finance Private Limited</p>
<h2>Service Description</h2>
<p>LockerHub provides safe deposit locker rental management services including locker allocation, payment processing, appointment booking, and document management.</p>
<h2>User Responsibilities</h2>
<p>Users must provide accurate personal information, maintain the security of their login credentials, use the locker only for lawful purposes, and comply with the terms of their rental agreement.</p>
<h2>Payment Terms</h2>
<p>Annual rent and security deposits are due as per your rental agreement. Overdue payments may result in access restrictions. Deposits are refundable upon lease termination subject to terms.</p>
<h2>Liability</h2>
<p>While we take reasonable measures to secure stored items, liability is limited to the terms specified in your locker rental agreement. We are not liable for items stored in violation of our policies.</p>
<h2>Termination</h2>
<p>Either party may terminate the agreement with 30 days notice. Upon termination, stored items must be removed and security deposits will be refunded minus any outstanding dues.</p>
<h2>Governing Law</h2>
<p>These terms are governed by the laws of India, with jurisdiction in Coimbatore, Tamil Nadu.</p>
<footer>© 2026 Dhanam Investment and Finance Private Limited. All rights reserved.</footer></body></html>`);
});

// Account deletion page (publicly accessible for Play Store requirement)
app.get('/delete-account', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delete Account - LockerHub by Dhanam</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#2c1810;line-height:1.7;background:#fff8f0}
h1{color:#b8860b;border-bottom:2px solid #b8860b;padding-bottom:12px}
.meta{color:#888;font-size:14px;margin-bottom:24px}
.card{background:#fff;border:1px solid #e0d5c3;border-radius:12px;padding:24px;margin:20px 0}
label{display:block;font-weight:600;margin-top:16px;margin-bottom:4px}
input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box}
button{background:#e74c3c;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:20px;width:100%}
button:hover{background:#c0392b}
.info{background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:16px;margin:20px 0;font-size:14px}
.success{background:#d4edda;border:1px solid #28a745;border-radius:8px;padding:16px;margin:20px 0;display:none}
footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font-size:13px;color:#888}</style></head>
<body><h1>Delete Your Account</h1>
<p class="meta">Dhanam Investment and Finance Private Limited</p>
<div class="info"><strong>What happens when you delete your account:</strong><br>
Your personal data (name, phone, email, address, ID documents) will be permanently deleted within 30 days. Payment records may be retained for up to 7 years as required by Indian financial regulations.</div>
<div class="card">
<p>To request account deletion, please provide the phone number associated with your account:</p>
<label for="phone">Registered Phone Number</label>
<input type="tel" id="phone" placeholder="Enter your 10-digit phone number" maxlength="10" pattern="[0-9]{10}">
<label for="reason">Reason for deletion (optional)</label>
<input type="text" id="reason" placeholder="Why are you leaving?">
<button onclick="requestDeletion()">Request Account Deletion</button>
</div>
<div class="success" id="successMsg">Your account deletion request has been submitted. We will process it within 30 days. You will receive a confirmation once completed.</div>
<script>
async function requestDeletion(){
  const phone=document.getElementById('phone').value.trim();
  if(!/^\\d{10}$/.test(phone)){alert('Please enter a valid 10-digit phone number');return;}
  try{
    const r=await fetch('/api/account/request-deletion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,reason:document.getElementById('reason').value})});
    if(r.ok){document.getElementById('successMsg').style.display='block';}
    else{const d=await r.json();alert(d.error||'Request failed. Please try again.');}
  }catch(e){alert('Unable to connect. Please try again later.');}
}
</script>
<footer>© 2026 Dhanam Investment and Finance Private Limited. All rights reserved.<br><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></footer></body></html>`);
});

app.get('/api/privacy-policy', (req, res) => {
  res.json({
    title: 'Privacy Policy',
    last_updated: '2026-03-30',
    company: 'Dhanam Investment and Finance Private Limited',
    sections: [
      { heading: 'Information We Collect', content: 'We collect personal information including name, phone number, email address, physical address, Aadhaar number (for e-sign verification), PAN number, bank account details (for deposit refunds), and passport-size photographs. This information is necessary for locker rental agreements and identity verification.' },
      { heading: 'How We Use Your Information', content: 'Your information is used to: manage your locker rental agreement, process payments and deposits, verify your identity for locker access, send appointment confirmations, generate lease agreements, and comply with regulatory requirements.' },
      { heading: 'Data Storage and Security', content: 'All data is stored on secure servers with encryption. Passwords are hashed using industry-standard bcrypt. API communications are secured with JWT tokens. Sensitive documents are stored in encrypted SharePoint repositories.' },
      { heading: 'Data Sharing', content: 'We do not sell or share your personal data with third parties except: Digio (for Aadhaar e-sign verification), payment processors, and as required by Indian law enforcement or regulatory authorities.' },
      { heading: 'Data Retention', content: 'Your data is retained for the duration of your locker rental agreement plus 7 years as required by Indian financial regulations. You may request earlier deletion subject to regulatory requirements.' },
      { heading: 'Your Rights', content: 'You have the right to: access your data, request corrections, export your data in portable format, and request deletion of your account. These can be done through the app or by contacting support.' },
      { heading: 'Contact', content: 'For privacy concerns, contact us at info@dhanamfinance.com or through the app support feature.' }
    ]
  });
});

app.get('/api/terms-of-service', (req, res) => {
  res.json({
    title: 'Terms of Service',
    last_updated: '2026-03-30',
    company: 'Dhanam Investment and Finance Private Limited',
    sections: [
      { heading: 'Service Description', content: 'LockerHub provides safe deposit locker rental management services including locker allocation, payment processing, appointment booking, and document management.' },
      { heading: 'User Responsibilities', content: 'Users must provide accurate personal information, maintain the security of their login credentials, use the locker only for lawful purposes, and comply with the terms of their rental agreement.' },
      { heading: 'Payment Terms', content: 'Annual rent and security deposits are due as per your rental agreement. Overdue payments may result in access restrictions. Deposits are refundable upon lease termination subject to terms.' },
      { heading: 'Liability', content: 'While we take reasonable measures to secure stored items, liability is limited to the terms specified in your locker rental agreement. We are not liable for items stored in violation of our policies.' },
      { heading: 'Termination', content: 'Either party may terminate the agreement with 30 days notice. Upon termination, stored items must be removed and security deposits will be refunded minus any outstanding dues.' },
      { heading: 'Governing Law', content: 'These terms are governed by the laws of India, with jurisdiction in Coimbatore, Tamil Nadu.' }
    ]
  });
});

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
app.get('/api/logs', requireAuth, requireRole('headoffice'), (req, res) => {
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
app.get('/api/logs/view', requireAuth, requireRole('headoffice'), (req, res) => {
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
    res.status(500).send('Error loading logs');
  }
});

// ============================
//  CUSTOMER LOGIN & PORTAL
// ============================
app.post('/api/customer-login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

    // Get first tenant with this phone number
    const firstMatch = db.prepare(`SELECT t.*, l.number as locker_number, b.name as branch_name
      FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
      LEFT JOIN branches b ON t.branch_id = b.id
      WHERE t.phone = ?`).get(phone);

    if (!firstMatch) {
      logWarn('Customer login failed - phone not found', { phone, ip: req.ip });
      return res.status(401).json({ error: 'Invalid phone number or password' });
    }

    // Support both bcrypt hashed and legacy plaintext passwords
    let passwordValid = false;
    if (firstMatch.customer_password.startsWith('$2a$') || firstMatch.customer_password.startsWith('$2b$')) {
      passwordValid = await bcrypt.compare(password, firstMatch.customer_password);
    } else {
      passwordValid = (firstMatch.customer_password === password);
      if (passwordValid) {
        // Auto-upgrade to bcrypt for all records with this phone
        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        db.prepare('UPDATE tenants SET customer_password = ? WHERE phone = ?').run(hashed, phone);
        logInfo('Customer password auto-upgraded to bcrypt', { phone });
      }
    }

    if (!passwordValid) {
      logWarn('Customer login failed - wrong password', { phone, ip: req.ip });
      return res.status(401).json({ error: 'Invalid phone number or password' });
    }

    // Fetch ALL tenant records for this phone (multi-branch / multi-locker)
    const allTenants = db.prepare(`SELECT t.id, t.name, t.phone, t.branch_id, t.locker_id, t.lease_start, t.lease_end, t.annual_rent, t.deposit,
      l.number as locker_number, b.name as branch_name
      FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id
      LEFT JOIN branches b ON t.branch_id = b.id
      WHERE t.phone = ? ORDER BY b.name`).all(phone);

    // Generate JWT token for customer
    const tokenPayload = { id: firstMatch.id, name: firstMatch.name, role: 'customer', phone: firstMatch.phone, branch_id: firstMatch.branch_id };
    const token = generateToken(tokenPayload);

    logInfo('Customer login success', { phone, tenant: firstMatch.name, totalLockers: allTenants.length });
    res.json({
      token,
      id: firstMatch.id, name: firstMatch.name, role: 'customer', phone: firstMatch.phone,
      branch_id: firstMatch.branch_id, branch_name: firstMatch.branch_name,
      locker_id: firstMatch.locker_id, locker_number: firstMatch.locker_number,
      lease_start: firstMatch.lease_start, lease_end: firstMatch.lease_end,
      annual_rent: firstMatch.annual_rent, deposit: firstMatch.deposit,
      tenants: allTenants
    });
  } catch (err) {
    logError('Customer login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// Set/Reset customer password (HO only) — sets for ALL tenant records with same phone
app.post('/api/tenants/:id/set-password', requireAuth, requireRole('headoffice', 'branch'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const tenant = db.prepare('SELECT id, name, phone FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  // Hash password and set for ALL tenant records with same phone number (multi-branch support)
  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = db.prepare('UPDATE tenants SET customer_password = ? WHERE phone = ?').run(hashedPassword, tenant.phone);
  logInfo('Customer password set', { tenant: tenant.name, phone: tenant.phone, recordsUpdated: result.changes });
  res.json({ success: true, message: `Password set for ${tenant.name} (${result.changes} locker record${result.changes > 1 ? 's' : ''})` });
});

// Customer payments (supports single tenant or all tenants by phone)
app.get('/api/customer/:tenantId/payments', requireAuth, (req, res) => {
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

// GDPR: Customer data export
app.get('/api/customer/:tenantId/export-data', requireAuth, (req, res) => {
  try {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Not found' });
    // Verify customer can only export their own data
    if (req.user.role === 'customer' && req.user.id !== req.params.tenantId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const payments = db.prepare('SELECT id, type, period, amount, due_date, status, paid_on, method, receipt_no, created_at FROM payments WHERE tenant_id = ?').all(req.params.tenantId);
    const visits = db.prepare('SELECT id, datetime, purpose, duration, notes, created_at FROM visits WHERE tenant_id = ?').all(req.params.tenantId);
    const appointments = db.prepare('SELECT id, requested_date, requested_time, purpose, status, created_at FROM appointments WHERE tenant_id = ?').all(req.params.tenantId);
    const feedback = db.prepare('SELECT * FROM feedback WHERE tenant_id = ?').all(req.params.tenantId);
    // Strip sensitive fields
    const exportData = {
      personal: { name: tenant.name, phone: tenant.phone, email: tenant.email, address: tenant.address },
      locker: { locker_id: tenant.locker_id, lease_start: tenant.lease_start, lease_end: tenant.lease_end, annual_rent: tenant.annual_rent, deposit: tenant.deposit },
      payments, visits, appointments, feedback,
      exported_at: new Date().toISOString()
    };
    auditLog('DATA_EXPORT', 'tenant', req.params.tenantId, req);
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// GDPR: Customer account deletion request
app.post('/api/customer/:tenantId/request-deletion', requireAuth, (req, res) => {
  try {
    const tenant = db.prepare('SELECT id, name, phone FROM tenants WHERE id = ?').get(req.params.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'customer' && req.user.id !== req.params.tenantId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Log the deletion request (actual deletion handled by admin within 30 days per GDPR)
    auditLog('DELETION_REQUESTED', 'tenant', req.params.tenantId, req, { name: tenant.name, phone: tenant.phone });
    logInfo('Data deletion requested', { tenantId: req.params.tenantId, name: tenant.name });
    res.json({ success: true, message: 'Deletion request received. Your data will be removed within 30 days as per our privacy policy.' });
  } catch (err) {
    res.status(500).json({ error: 'Request failed' });
  }
});

// Public account deletion request (no auth required — for Play Store compliance)
app.post('/api/account/request-deletion', (req, res) => {
  try {
    const { phone, reason } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Please provide a valid 10-digit phone number' });
    }
    const tenants = db.prepare('SELECT id, name FROM tenants WHERE phone = ?').all(phone);
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'No account found with this phone number' });
    }
    tenants.forEach(t => {
      auditLog('DELETION_REQUESTED_WEB', 'tenant', t.id, req, { name: t.name, phone, reason: reason || '' });
    });
    logInfo('Public deletion request', { phone, tenants: tenants.length, reason: reason || '' });
    res.json({ success: true, message: 'Deletion request received.' });
  } catch (err) {
    res.status(500).json({ error: 'Request failed' });
  }
});

// ============================
//  PUBLIC ENQUIRY / LEAD SIGNUP (no auth)
// ============================
// Public: List branches (name & id only, for signup form)
app.get('/api/public/branches', (req, res) => {
  try {
    const branches = db.prepare('SELECT id, name, location FROM branches ORDER BY name').all();
    res.json(branches);
  } catch (err) {
    logError('Public branches list failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public: Submit enquiry → creates a lead
app.post('/api/public/enquiry', (req, res) => {
  try {
    const { name, phone, email, locker_size, branch_id, notes, source } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(0, 10);
    if (!cleanPhone || cleanPhone.length !== 10) return res.status(400).json({ error: 'Please provide a valid 10-digit phone number' });
    // Rate limit: max 3 enquiries per phone per day
    const today = new Date().toISOString().slice(0, 10);
    const recentCount = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE phone = ? AND created_at >= ?").get(cleanPhone, today + ' 00:00:00');
    if (recentCount && recentCount.cnt >= 3) {
      return res.status(429).json({ error: 'Too many enquiries. Please try again tomorrow or call us directly.' });
    }
    // Detect source: mobile_app or web_app
    const leadSource = source === 'mobile_app' ? 'Mobile App' : 'Web App';
    const id = genId();
    db.prepare(`INSERT INTO leads (id, name, phone, email, locker_size, branch_id, notes, status, created_by, created_by_name, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, name.trim(), cleanPhone, (email || '').trim(), locker_size || '', branch_id || '', (notes || '').trim(), 'New', 'self-signup', 'Customer Enquiry', leadSource
    );
    logInfo('Public enquiry submitted', { id, name: name.trim(), phone: cleanPhone, source: leadSource });
    res.json({ success: true, message: 'Thank you for your enquiry! Our team will contact you shortly.' });
  } catch (err) {
    logError('Public enquiry failed', { error: err.message });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ============================
//  APPOINTMENTS
// ============================
app.get('/api/appointments', requireAuth, (req, res) => {
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

// Slot availability: returns all 30-min slots for a date+branch with status
app.get('/api/appointments/slots', requireAuth, (req, res) => {
  const { branch_id, date } = req.query;
  if (!branch_id || !date) return res.status(400).json({ error: 'branch_id and date are required' });

  // Get all non-cancelled/rejected appointments for this branch+date
  const appts = db.prepare(
    `SELECT a.*, t.name as tenant_name FROM appointments a LEFT JOIN tenants t ON a.tenant_id = t.id
     WHERE a.branch_id = ? AND a.requested_date = ? AND a.status NOT IN ('Cancelled', 'Rejected')`
  ).all(branch_id, date);

  // Generate all 30-min slots from 9:00 to 17:30
  const slots = [];
  for (let h = 9; h < 18; h++) {
    for (let m = 0; m < 60; m += 30) {
      const time = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      const slotAppts = appts.filter(a => (a.requested_time || '').substring(0, 5) === time);
      const confirmed = slotAppts.find(a => a.status === 'Approved' || a.status === 'Completed');
      const pending = slotAppts.find(a => a.status === 'Pending');
      slots.push({
        time,
        status: confirmed ? 'booked' : pending ? 'pending' : 'available',
        tenant_name: confirmed ? confirmed.tenant_name : pending ? pending.tenant_name : null,
        appointment_id: confirmed ? confirmed.id : pending ? pending.id : null
      });
    }
  }
  res.json(slots);
});

app.post('/api/appointments', requireAuth, (req, res) => {
  const d = req.body;
  if (!d.branch_id || !d.tenant_id || !d.requested_date) {
    return res.status(400).json({ error: 'Branch, tenant, and date are required' });
  }
  if (!d.requested_time) {
    return res.status(400).json({ error: 'Please select a time slot' });
  }

  // Validate date is not in the past
  const today = new Date().toISOString().split('T')[0];
  if (d.requested_date < today) {
    return res.status(400).json({ error: 'Cannot book appointments in the past' });
  }

  // Validate date is within 3 months
  const maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + 3);
  if (d.requested_date > maxDate.toISOString().split('T')[0]) {
    return res.status(400).json({ error: 'Appointments can only be booked up to 3 months in advance' });
  }

  // Validate the time slot is within operating hours (09:00 - 17:30)
  const [hh, mm] = (d.requested_time || '').split(':').map(Number);
  if (isNaN(hh) || hh < 9 || hh > 17 || (hh === 17 && mm > 30) || (mm !== 0 && mm !== 30)) {
    return res.status(400).json({ error: 'Invalid time slot. Slots are every 30 minutes from 9:00 AM to 5:30 PM' });
  }
  const slotTime = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');

  // Validate time slot is not in the past (for today's date)
  if (d.requested_date === today) {
    const now = new Date();
    const slotDateTime = new Date(d.requested_date + 'T' + slotTime + ':00');
    if (slotDateTime <= now) {
      return res.status(400).json({ error: 'This time slot has already passed. Please choose a later slot.' });
    }
  }

  // Check for conflicts: is there already a confirmed (Approved/Completed) appointment at this slot?
  const conflict = db.prepare(
    `SELECT id, status FROM appointments
     WHERE branch_id = ? AND requested_date = ? AND substr(requested_time, 1, 5) = ?
     AND status IN ('Approved', 'Completed')`
  ).get(d.branch_id, d.requested_date, slotTime);

  if (conflict) {
    return res.status(409).json({ error: 'This time slot is already booked. Please choose a different slot.' });
  }

  const id = genId();
  const locker_id = d.locker_id || '';
  const status = d.booked_by === 'customer' ? 'Pending' : 'Approved';

  // If staff is approving directly, also check no other pending exists to avoid double-booking
  if (status === 'Approved') {
    const pendingConflict = db.prepare(
      `SELECT id FROM appointments
       WHERE branch_id = ? AND requested_date = ? AND substr(requested_time, 1, 5) = ?
       AND status = 'Pending'`
    ).get(d.branch_id, d.requested_date, slotTime);
    // Auto-reject conflicting pending if staff books directly
    if (pendingConflict) {
      db.prepare(`UPDATE appointments SET status = 'Rejected', admin_notes = 'Auto-rejected: slot booked by staff' WHERE id = ?`)
        .run(pendingConflict.id);
      logInfo('Pending appointment auto-rejected due to staff booking', { rejectedId: pendingConflict.id });
    }
  }

  db.prepare(`INSERT INTO appointments (id, branch_id, tenant_id, locker_id, requested_date, requested_time, purpose, status, booked_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, d.branch_id, d.tenant_id, locker_id, d.requested_date, slotTime, d.purpose || 'Locker Access', status, d.booked_by || 'customer', d.notes || '');
  logInfo('Appointment created', { id, tenant: d.tenant_id, date: d.requested_date, time: slotTime, booked_by: d.booked_by || 'customer', status });
  res.json({ success: true, id, status });
});

app.put('/api/appointments/:id/status', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const { status, admin_notes } = req.body;
  if (!['Approved', 'Rejected', 'Completed', 'Cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  // Conflict check when approving: make sure slot isn't already booked
  if (status === 'Approved' && appt.requested_time) {
    const slotTime = (appt.requested_time || '').substring(0, 5);
    const existing = db.prepare(
      `SELECT id FROM appointments
       WHERE branch_id = ? AND requested_date = ? AND substr(requested_time, 1, 5) = ?
       AND status IN ('Approved', 'Completed') AND id != ?`
    ).get(appt.branch_id, appt.requested_date, slotTime, appt.id);
    if (existing) {
      return res.status(409).json({ error: 'Cannot approve — this time slot is already booked by another appointment.' });
    }
  }

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

app.delete('/api/appointments/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run('Cancelled', req.params.id);
  logInfo('Appointment cancelled', { id: req.params.id });
  res.json({ success: true });
});

// ============================
//  E-SIGN (Digio Integration)
// ============================
const DIGIO_CONFIG = {
  sandbox: {
    baseUrl: 'ext.digio.in',
    port: 444,
    clientId: process.env.DIGIO_CLIENT_ID || '',
    clientSecret: process.env.DIGIO_CLIENT_SECRET || ''
  },
  production: {
    baseUrl: 'api.digio.in',
    port: 443,
    clientId: process.env.DIGIO_CLIENT_ID || '',
    clientSecret: process.env.DIGIO_CLIENT_SECRET || ''
  }
};

const DIGIO_ENV = process.env.DIGIO_ENV === 'production' ? 'production' : 'sandbox';
const digio = DIGIO_CONFIG[DIGIO_ENV];
const DIGIO_AUTH = Buffer.from(`${digio.clientId}:${digio.clientSecret}`).toString('base64');

function digioRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Basic ${DIGIO_AUTH}`
    };
    if (body && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }
    const options = {
      hostname: digio.baseUrl,
      port: digio.port,
      path: apiPath,
      method: method,
      headers: headers,
      rejectUnauthorized: process.env.NODE_ENV !== 'development',
      timeout: 25000
    };

    logInfo('Digio API call', { method, path: apiPath });

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        logInfo('Digio API response', { status: res.statusCode, path: apiPath, body: data.substring(0, 200) });
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject({ status: res.statusCode, ...parsed });
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject({ status: res.statusCode, message: data });
          }
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject({ message: 'Digio API request timed out' }); });
    req.on('error', (err) => { logError('Digio API error', { error: err.message, path: apiPath }); reject(err); });
    if (body && method !== 'GET') req.write(JSON.stringify(body));
    req.end();
  });
}

// ============================
//  SHAREPOINT / MICROSOFT GRAPH
// ============================
const SHAREPOINT_CONFIG = {
  clientId: process.env.MS_CLIENT_ID || '',
  clientSecret: process.env.MS_CLIENT_SECRET || '',
  tenantId: process.env.MS_TENANT_ID || '',
  baseFolder: 'LockerHub'                 // Target folder inside the Documents library
  // Sub-folders: Application (agreements), Payment Receipt (receipts)
};

let _msTokenCache = { token: null, expiresAt: 0 };

async function getMsGraphToken() {
  if (_msTokenCache.token && Date.now() < _msTokenCache.expiresAt - 60000) {
    return _msTokenCache.token;
  }
  const tokenUrl = `https://login.microsoftonline.com/${SHAREPOINT_CONFIG.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: SHAREPOINT_CONFIG.clientId,
    client_secret: SHAREPOINT_CONFIG.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  }).toString();

  return new Promise((resolve, reject) => {
    const url = new URL(tokenUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _msTokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in * 1000) };
            resolve(json.access_token);
          } else {
            reject(new Error(json.error_description || json.error || 'Token fetch failed'));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function msGraphRequest(method, apiPath, body) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getMsGraphToken();
      const url = new URL(`https://graph.microsoft.com${apiPath}`);
      const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject({ status: res.statusCode, message: json.error?.message || data });
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch (e) { reject(e); }
  });
}

function msGraphUpload(apiPath, buffer, token, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.microsoft.com${apiPath}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType || 'application/pdf',
        'Content-Length': buffer.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject({ status: res.statusCode, message: json.error?.message || data });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// SharePoint drive ID for "Dhanam Repository" → "Documents" library
// Site: kiaramfi.sharepoint.com/sites/repo
const SP_DRIVE_ID = process.env.SP_DRIVE_ID || 'b!fTFvCiz6zE-llOUnFj-hq13WSlu_wi9DhOZmzoXbbKHqXSKxXxhHSYHoWokQoP03';

// Upload a signed PDF to SharePoint → Dhanam Repository → Locker Applications
async function uploadToSharePoint(fileBuffer, fileName, subfolder, contentType) {
  try {
    const token = await getMsGraphToken();

    const folderPath = subfolder
      ? `${SHAREPOINT_CONFIG.baseFolder}/${subfolder}`
      : SHAREPOINT_CONFIG.baseFolder;
    const safeName = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');

    // Simple upload (files < 4MB)
    const uploadPath = `/v1.0/drives/${SP_DRIVE_ID}/root:/${folderPath}/${safeName}:/content`;
    const result = await msGraphUpload(uploadPath, fileBuffer, token, contentType || 'application/pdf');
    logInfo('SharePoint upload success', { fileName: safeName, webUrl: result.webUrl });
    return result.webUrl || result.id || 'uploaded';
  } catch (err) {
    logError('SharePoint upload failed', { error: err.message || JSON.stringify(err), fileName });
    throw err;
  }
}

function digioDownload(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: digio.baseUrl,
      port: digio.port,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${DIGIO_AUTH}`
      },
      rejectUnauthorized: process.env.NODE_ENV !== 'development'
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(buffer);
        } else {
          reject({ status: res.statusCode, message: buffer.toString() });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// List all e-sign requests
app.get('/api/esign', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  const { branch_id } = req.query;
  let sql = `SELECT e.*, t.name as tenant_name, t.phone as tenant_phone, b.name as branch_name
    FROM esign_requests e
    LEFT JOIN tenants t ON e.tenant_id = t.id
    LEFT JOIN branches b ON e.branch_id = b.id`;
  const params = [];
  if (branch_id && branch_id !== 'all') {
    sql += ' WHERE e.branch_id = ?';
    params.push(branch_id);
  }
  sql += ' ORDER BY e.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Initiate e-sign: upload PDF to Digio and get auth URL
app.post('/api/esign/initiate', requireAuth, requireRole('headoffice', 'branch'), async (req, res) => {
  try {
    const { tenant_id, document_type, branch_id } = req.body;

    // Get tenant details
    const tenant = db.prepare('SELECT t.*, l.number as locker_number, l.size as locker_size FROM tenants t LEFT JOIN lockers l ON t.locker_id = l.id WHERE t.id = ?').get(tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branch_id || tenant.branch_id);
    const locker = tenant.locker_id ? db.prepare('SELECT * FROM lockers WHERE id = ?').get(tenant.locker_id) : {};

    // Generate PDF based on document type
    let pdfBuffer, fileName;
    if (document_type === 'receipt') {
      // Find the latest paid payment for this tenant
      const payment = db.prepare(`SELECT p.*, t.name as tenant_name, t.phone as tenant_phone, l.number as locker_number, l.size as locker_size
        FROM payments p
        LEFT JOIN tenants t ON p.tenant_id = t.id
        LEFT JOIN lockers l ON p.locker_id = l.id
        WHERE p.tenant_id = ? AND p.status = 'Paid' ORDER BY p.paid_on DESC LIMIT 1`).get(tenant_id);
      if (!payment) return res.status(400).json({ error: 'No paid payment found for this tenant' });
      const pTenant = { name: payment.tenant_name, phone: payment.tenant_phone, locker_number: payment.locker_number };
      const pLocker = { number: payment.locker_number, size: payment.locker_size };
      pdfBuffer = await generateReceiptBuffer(payment, pTenant, branch || {}, pLocker || {}, { forEsign: true });
      const custName = (payment.tenant_name || 'customer').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
      fileName = `Signed_Receipt_${custName}.pdf`;
    } else {
      // Agreement / allotment form
      const payments = db.prepare('SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at ASC').all(tenant_id);
      const paidDeposit = payments.find(p => p.type === 'deposit' && p.status === 'Paid');
      const paidRent = payments.find(p => p.type === 'rent' && p.status === 'Paid');
      tenant.deposit_amount = paidDeposit ? paidDeposit.amount : 0;
      tenant.rent_amount = paidRent ? paidRent.amount : 0;
      const branchShort = (branch && branch.name ? branch.name.replace(/\s+/g, '').substring(0, 4).toUpperCase() : 'HQ');
      const year = new Date(tenant.lease_start || tenant.created_at || Date.now()).getFullYear();
      const tenantSeq = db.prepare('SELECT COUNT(*) as cnt FROM tenants WHERE branch_id = ? AND created_at <= ?').get(tenant.branch_id, tenant.created_at || new Date().toISOString());
      tenant.agreement_no = `DFIN/${branchShort}/${year}/${String((tenantSeq ? tenantSeq.cnt : 1)).padStart(4, '0')}`;
      tenant.allotment_date = tenant.lease_start || new Date().toISOString().split('T')[0];
      pdfBuffer = await generatePdfBuffer(tenant, branch || {}, locker || {});
      const custNameAg = (tenant.name || 'customer').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
      fileName = `Signed_Agreement_${custNameAg}.pdf`;
    }

    // Call Digio API to upload PDF and create sign request
    const fileBase64 = pdfBuffer.toString('base64');

    // Use email as primary identifier; phone as fallback
    // Digio sends signing link to the identifier channel (email or SMS)
    const digioIdentifier = tenant.email || tenant.phone;
    if (!digioIdentifier) return res.status(400).json({ error: 'Tenant has no email or phone for signing' });

    // Sign coordinates: bottom-right of every page with margin from edges
    // A4 = 595.28 x 841.89 pts, PDF origin = bottom-left
    // Box: ~200 x 90 pts, ~40pt from right edge, ~40pt from bottom edge
    const pageCount = (pdfBuffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    const signerPages = {};
    for (let p = 1; p <= (pageCount || 1); p++) {
      signerPages[String(p)] = [{ llx: 355, lly: 40, urx: 555, ury: 130 }];
    }
    const signCoords = { [digioIdentifier]: signerPages };

    // Build signer object with both email and phone so Digio notifies on both channels
    const signerObj = {
      identifier: digioIdentifier,
      name: tenant.name,
      sign_type: 'aadhaar',
      reason: document_type === 'receipt' ? 'Payment receipt acknowledgement' : 'Locker rental agreement'
    };
    // Explicitly set both channels so Digio sends signing link via email AND SMS
    if (tenant.email) signerObj.email = tenant.email;
    if (tenant.phone) {
      // Digio expects phone with country code (e.g., +91XXXXXXXXXX)
      const phone = tenant.phone.startsWith('+') ? tenant.phone : '+91' + tenant.phone.replace(/^0+/, '');
      signerObj.phone = phone;
    }

    const digioPayload = {
      signers: [signerObj],
      expire_in_days: 10,
      display_on_page: 'custom',
      notify_signers: true,
      send_sign_link: true,
      file_name: fileName,
      generate_access_token: true,
      include_authentication_url: 'true',
      file_data: fileBase64,
      sign_coordinates: signCoords
    };

    // Log payload for debugging (without file_data)
    const debugPayload = { ...digioPayload, file_data: `[${fileBase64.length} chars base64, ${pageCount} pages]` };
    logInfo('Digio upload payload', debugPayload);

    const digioResp = await digioRequest('POST', '/v2/client/document/uploadpdf', digioPayload);

    // Extract auth URL from response — prefer authentication_url (clickable link)
    let authUrl = '';
    if (digioResp.signing_parties && digioResp.signing_parties.length > 0) {
      authUrl = digioResp.signing_parties[0].authentication_url || '';
    }

    // Save to DB
    const id = genId();
    db.prepare(`INSERT INTO esign_requests (id, branch_id, tenant_id, document_type, file_name, signer_name, signer_identifier, sign_type, status, digio_doc_id, auth_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, tenant.branch_id, tenant_id, document_type, fileName, tenant.name, digioIdentifier, 'aadhaar',
      digioResp.status || 'requested', digioResp.id || '', authUrl, ''
    );

    logInfo('E-sign initiated', { id, tenant: tenant.name, type: document_type, digioId: digioResp.id });

    res.json({
      success: true,
      esign_id: id,
      digio_doc_id: digioResp.id,
      auth_url: authUrl,
      status: digioResp.status,
      signing_parties: digioResp.signing_parties
    });
  } catch (err) {
    logError('E-sign initiation failed', { error: err.message || JSON.stringify(err) });
    res.status(500).json({ error: err.message || 'E-sign initiation failed', details: err });
  }
});

// Upload custom PDF for e-sign
app.post('/api/esign/upload', express.raw({ type: 'application/pdf', limit: '20mb' }), async (req, res) => {
  // This endpoint is handled via multipart — let's use a different approach
  res.status(501).json({ error: 'Use /api/esign/initiate for auto-generated documents' });
});

// Check e-sign status from Digio
app.get('/api/esign/:id/status', requireAuth, async (req, res) => {
  try {
    const esign = db.prepare('SELECT * FROM esign_requests WHERE id = ?').get(req.params.id);
    if (!esign) return res.status(404).json({ error: 'E-sign request not found' });
    if (!esign.digio_doc_id) return res.status(400).json({ error: 'No Digio document ID found' });

    logInfo('Checking e-sign status', { id: req.params.id, digio_doc_id: esign.digio_doc_id });

    const digioResp = await digioRequest('GET', `/v2/client/document/${esign.digio_doc_id}`, null);

    logInfo('Digio status response', { id: req.params.id, response: JSON.stringify(digioResp).substring(0, 500) });

    // Determine status - check multiple possible fields
    let newStatus = esign.status;
    if (digioResp.status) {
      newStatus = digioResp.status;
    } else if (digioResp.signing_parties && digioResp.signing_parties.length > 0) {
      // Check individual signer status
      const signerStatus = digioResp.signing_parties[0].status;
      if (signerStatus) newStatus = signerStatus;
    }

    db.prepare('UPDATE esign_requests SET status = ?, updated_at = datetime(?) WHERE id = ?')
      .run(newStatus, new Date().toISOString(), req.params.id);

    res.json({ status: newStatus, digio_status: digioResp.status, signing_parties: digioResp.signing_parties, local_id: esign.id, digio_doc_id: esign.digio_doc_id, onedrive_url: esign.onedrive_url || '' });
  } catch (err) {
    const errMsg = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
    logError('E-sign status check failed', { id: req.params.id, error: errMsg, status: err.status });
    // Return the Digio error details if available
    res.status(err.status || 500).json({ error: errMsg, digio_status: err.status, details: typeof err === 'object' ? err : {} });
  }
});

// Download signed document from Digio
app.get('/api/esign/:id/download', requireAuth, async (req, res) => {
  try {
    const esign = db.prepare('SELECT * FROM esign_requests WHERE id = ?').get(req.params.id);
    if (!esign) return res.status(404).json({ error: 'E-sign request not found' });
    if (!esign.digio_doc_id) return res.status(400).json({ error: 'No Digio document ID found' });

    const pdfBuffer = await digioDownload(`/v2/client/document/download?document_id=${esign.digio_doc_id}`);

    const safeName = (esign.file_name || 'signed_document').replace(/\.pdf$/i, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Signed_${safeName}.pdf`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    logError('E-sign download failed', { error: err.message || JSON.stringify(err) });
    res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// Preview signed document (inline in browser)
app.get('/api/esign/:id/preview', requireAuth, async (req, res) => {
  try {
    const esign = db.prepare('SELECT * FROM esign_requests WHERE id = ?').get(req.params.id);
    if (!esign) return res.status(404).json({ error: 'E-sign request not found' });
    if (!esign.digio_doc_id) return res.status(400).json({ error: 'No Digio document ID found' });

    const pdfBuffer = await digioDownload(`/v2/client/document/download?document_id=${esign.digio_doc_id}`);

    const safeName = (esign.file_name || 'signed_document').replace(/\.pdf$/i, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Signed_${safeName}.pdf`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    logError('E-sign preview failed', { error: err.message || JSON.stringify(err) });
    res.status(500).json({ error: err.message || 'Preview failed' });
  }
});

// Save signed document to SharePoint (Dhanam Repository → Locker Applications)
app.post('/api/esign/:id/save-to-repo', requireAuth, requireRole('headoffice', 'branch'), async (req, res) => {
  try {
    const esign = db.prepare('SELECT * FROM esign_requests WHERE id = ?').get(req.params.id);
    if (!esign) return res.status(404).json({ error: 'E-sign request not found' });
    if (!esign.digio_doc_id) return res.status(400).json({ error: 'No Digio document ID found' });

    // Check if already uploaded
    if (esign.onedrive_url) {
      return res.json({ success: true, onedrive_url: esign.onedrive_url, message: 'Already saved to repository' });
    }

    logInfo('Saving signed doc to SharePoint', { id: req.params.id, digio_doc_id: esign.digio_doc_id });

    // Download from Digio
    const signedPdf = await digioDownload(`/v2/client/document/download?document_id=${esign.digio_doc_id}`);

    // Build subfolder: DocType/BranchName/TenantName
    // Agreements → Application, Receipts → Payment Receipt
    const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(esign.branch_id);
    const tenant = db.prepare('SELECT name FROM tenants WHERE id = ?').get(esign.tenant_id);
    const branchName = (branch?.name || 'Unknown').replace(/[^a-zA-Z0-9_ \-]/g, '');
    const tenantName = (tenant?.name || 'Unknown').replace(/[^a-zA-Z0-9_ \-]/g, '');
    const docTypeFolder = (esign.document_type === 'receipt') ? 'Payment Receipt' : 'Application';
    const subfolder = `${docTypeFolder}/${branchName}/${tenantName}`;
    const fileName = esign.file_name || 'Signed_document.pdf';

    // Upload to SharePoint
    const sharePointUrl = await uploadToSharePoint(signedPdf, fileName, subfolder);

    // Save the URL
    db.prepare('UPDATE esign_requests SET onedrive_url = ?, updated_at = datetime(?) WHERE id = ?')
      .run(sharePointUrl, new Date().toISOString(), req.params.id);

    logInfo('Signed doc saved to SharePoint', { id: req.params.id, url: sharePointUrl });
    res.json({ success: true, onedrive_url: sharePointUrl });
  } catch (err) {
    logError('Save to repo failed', { id: req.params.id, error: err.message || JSON.stringify(err) });
    res.status(500).json({ error: err.message || 'Failed to save to repository' });
  }
});

// Cancel e-sign request
app.post('/api/esign/:id/cancel', requireAuth, requireRole('headoffice', 'branch'), async (req, res) => {
  try {
    const esign = db.prepare('SELECT * FROM esign_requests WHERE id = ?').get(req.params.id);
    if (!esign) return res.status(404).json({ error: 'E-sign request not found' });

    // Try to cancel on Digio (may fail for already signed/expired docs — that's ok)
    let digioResult = {};
    if (esign.digio_doc_id) {
      try {
        digioResult = await digioRequest('PATCH', `/v2/client/document/${esign.digio_doc_id}`, { status: 'cancelled' });
      } catch (digioErr) {
        logInfo('Digio cancel failed (proceeding with local delete)', { error: digioErr.message || JSON.stringify(digioErr) });
      }
    }

    // Delete from local DB regardless
    db.prepare('DELETE FROM esign_requests WHERE id = ?').run(req.params.id);

    logInfo('E-sign deleted', { id: req.params.id, digioId: esign.digio_doc_id });
    res.json({ success: true, deleted: true });
  } catch (err) {
    logError('E-sign cancel/delete failed', { error: err.message || JSON.stringify(err) });
    res.status(500).json({ error: err.message || 'Cancel failed' });
  }
});

// Webhook endpoint for Digio status updates
app.post('/api/esign/webhook', (req, res) => {
  try {
    const { document_id, status } = req.body;
    if (document_id) {
      const esign = db.prepare('SELECT * FROM esign_requests WHERE digio_doc_id = ?').get(document_id);
      if (esign) {
        db.prepare('UPDATE esign_requests SET status = ?, updated_at = datetime(?) WHERE digio_doc_id = ?')
          .run(status || 'updated', new Date().toISOString(), document_id);
        logInfo('E-sign webhook received', { digioId: document_id, status });
      }
    }
    res.json({ success: true });
  } catch (err) {
    logError('E-sign webhook error', { error: err.message });
    res.json({ success: true }); // Always return 200 to Digio
  }
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
//  FEEDBACK
// ============================

// Check if customer already submitted feedback
app.get('/api/customer/:tenantId/feedback/status', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT id FROM feedback WHERE tenant_id = ?').get(req.params.tenantId);
    res.json({ submitted: !!row });
  } catch (err) {
    logError('Feedback status check failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit feedback (customer)
app.post('/api/feedback', requireAuth, (req, res) => {
  try {
    const { tenant_id, branch_id, q1, q2, q3, q4, q5, q6, q7, reason_chose, nps_score } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

    // Check if already submitted
    const existing = db.prepare('SELECT id FROM feedback WHERE tenant_id = ?').get(tenant_id);
    if (existing) return res.status(409).json({ error: 'Feedback already submitted' });

    const total = (q1||0) + (q2||0) + (q3||0) + (q4||0) + (q5||0) + (q6||0) + (q7||0);
    const maxScore = 35; // 7 questions × 5 max
    const pct = Math.round((total / maxScore) * 100 * 100) / 100;

    db.prepare(`INSERT INTO feedback (tenant_id, branch_id, q1_time_satisfaction, q2_procedure_explained, q3_locker_suits, q4_procedure_simple, q5_safety_adequate, q6_ambience_pleasant, q7_staff_oriented, reason_chose, nps_score, total_score, satisfaction_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tenant_id, branch_id || '', q1||0, q2||0, q3||0, q4||0, q5||0, q6||0, q7||0, reason_chose || '', nps_score||0, total, pct
    );
    logInfo('Feedback submitted', { tenant_id, total, pct });
    res.json({ success: true, total_score: total, satisfaction_pct: pct });
  } catch (err) {
    logError('Feedback submit failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all feedback (HO/Branch view)
app.get('/api/feedback', requireAuth, enforceBranchScope, (req, res) => {
  try {
    const branchId = req.query.branch_id;
    let sql = `SELECT f.*, t.name as tenant_name, t.phone as tenant_phone, b.name as branch_name
      FROM feedback f
      LEFT JOIN tenants t ON f.tenant_id = t.id
      LEFT JOIN branches b ON f.branch_id = b.id`;
    const params = [];
    if (branchId) {
      sql += ' WHERE f.branch_id = ?';
      params.push(branchId);
    }
    sql += ' ORDER BY f.created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    logError('Feedback list failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get feedback summary stats (HO/Branch)
app.get('/api/feedback/summary', requireAuth, (req, res) => {
  try {
    const branchId = req.query.branch_id;
    let where = '';
    const params = [];
    if (branchId) {
      where = 'WHERE f.branch_id = ?';
      params.push(branchId);
    }
    const summary = db.prepare(`SELECT
      COUNT(*) as total_responses,
      ROUND(AVG(f.satisfaction_pct), 1) as avg_satisfaction,
      ROUND(AVG(f.nps_score), 1) as avg_nps,
      ROUND(AVG(f.q1_time_satisfaction), 1) as avg_q1,
      ROUND(AVG(f.q2_procedure_explained), 1) as avg_q2,
      ROUND(AVG(f.q3_locker_suits), 1) as avg_q3,
      ROUND(AVG(f.q4_procedure_simple), 1) as avg_q4,
      ROUND(AVG(f.q5_safety_adequate), 1) as avg_q5,
      ROUND(AVG(f.q6_ambience_pleasant), 1) as avg_q6,
      ROUND(AVG(f.q7_staff_oriented), 1) as avg_q7,
      SUM(CASE WHEN f.nps_score >= 9 THEN 1 ELSE 0 END) as promoters,
      SUM(CASE WHEN f.nps_score >= 7 AND f.nps_score <= 8 THEN 1 ELSE 0 END) as passives,
      SUM(CASE WHEN f.nps_score <= 6 THEN 1 ELSE 0 END) as detractors
      FROM feedback f ${where}`).get(...params);
    res.json(summary);
  } catch (err) {
    logError('Feedback summary failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================
//  LEADS
// ============================

// Create a lead (lead_agent, branch, or HO)
app.post('/api/leads', requireAuth, (req, res) => {
  try {
    const { name, email, locker_size, branch_id, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    // Sanitize phone: digits only, max 10
    const phone = (req.body.phone || '').replace(/[^0-9]/g, '').slice(0, 10);
    if (phone && phone.length !== 10) return res.status(400).json({ error: 'Phone must be exactly 10 digits' });
    const id = genId();
    const created_by = req.body.created_by || '';
    const created_by_name = req.body.created_by_name || '';
    db.prepare(`INSERT INTO leads (id, name, phone, email, locker_size, branch_id, notes, status, created_by, created_by_name, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, name, phone, email || '', locker_size || '', branch_id || '', notes || '', 'New', created_by, created_by_name, 'Staff'
    );
    logInfo('Lead created', { id, name, phone, created_by: created_by_name });
    res.json({ id, success: true });
  } catch (err) {
    logError('Lead creation failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List leads (HO sees all, branch sees own, lead_agent sees own)
app.get('/api/leads', requireAuth, (req, res) => {
  try {
    const { branch_id, created_by, status } = req.query;
    let sql = `SELECT l.*, b.name as branch_name FROM leads l LEFT JOIN branches b ON l.branch_id = b.id`;
    const conditions = [];
    const params = [];
    if (branch_id) { conditions.push('l.branch_id = ?'); params.push(branch_id); }
    if (created_by) { conditions.push('l.created_by = ?'); params.push(created_by); }
    if (status) { conditions.push('l.status = ?'); params.push(status); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY l.created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    logError('Lead list failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update lead (status, notes, visit_time, editable fields, converted_tenant_id)
app.put('/api/leads/:id', requireAuth, (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const fields = ['status', 'notes', 'branch_id', 'visit_time', 'name', 'phone', 'email', 'locker_size', 'converted_tenant_id'];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        db.prepare(`UPDATE leads SET ${f} = ?, updated_at = datetime('now') WHERE id = ?`).run(req.body[f], req.params.id);
      }
    });
    logInfo('Lead updated', { id: req.params.id, status: req.body.status });
    res.json({ ok: true });
  } catch (err) {
    logError('Lead update failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a lead
app.delete('/api/leads/:id', requireAuth, requireRole('headoffice', 'branch'), (req, res) => {
  try {
    db.prepare('DELETE FROM lead_notes WHERE lead_id = ?').run(req.params.id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
    logInfo('Lead deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    logError('Lead delete failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Lead telecalling notes
app.get('/api/leads/:id/notes', requireAuth, (req, res) => {
  try {
    const notes = db.prepare('SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json(notes);
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/leads/:id/notes', requireAuth, (req, res) => {
  try {
    const { note, created_by, created_by_name } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });
    const id = genId();
    db.prepare('INSERT INTO lead_notes (id, lead_id, note, created_by, created_by_name) VALUES (?, ?, ?, ?, ?)').run(
      id, req.params.id, note.trim(), created_by || '', created_by_name || ''
    );
    logInfo('Lead note added', { leadId: req.params.id, by: created_by_name });
    res.json({ id, ok: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// Lead summary stats
app.get('/api/leads/summary', requireAuth, (req, res) => {
  try {
    const { branch_id } = req.query;
    let where = '';
    const params = [];
    if (branch_id) { where = 'WHERE branch_id = ?'; params.push(branch_id); }
    const total = db.prepare(`SELECT COUNT(*) as c FROM leads ${where}`).get(...params).c;
    const byStatus = db.prepare(`SELECT status, COUNT(*) as c FROM leads ${where} GROUP BY status`).all(...params);
    const byAgent = db.prepare(`SELECT created_by_name, COUNT(*) as c FROM leads ${where} GROUP BY created_by_name ORDER BY c DESC`).all(...params);
    const bySize = db.prepare(`SELECT locker_size, COUNT(*) as c FROM leads ${where} GROUP BY locker_size ORDER BY c DESC`).all(...params);
    res.json({ total, by_status: byStatus, by_agent: byAgent, by_size: bySize });
  } catch (err) {
    logError('Lead summary failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
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
