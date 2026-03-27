/**
 * LockerHub - First-time Setup Script
 * Creates admin account, RS Puram branch, locker types, and actual inventory.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new Database(path.join(DATA_DIR, 'lockerhub.db'));
db.pragma('journal_mode = WAL');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

function classifySize(h, w, d) {
  const vol = (h * w * d) / 1000000;
  if (vol <= 50) return 'Small';
  if (vol <= 120) return 'Medium';
  if (vol <= 250) return 'Large';
  return 'XL';
}

async function main() {
  console.log('\n  LockerHub - Setup Wizard\n  ========================\n');

  // Check if already setup
  try {
    const existing = db.prepare("SELECT * FROM users WHERE role = 'headoffice'").get();
    if (existing) {
      console.log('  System already initialized. Admin: ' + existing.username);
      const cont = await ask('  Re-run setup? This will add missing data only. (y/n): ');
      if (cont.toLowerCase() !== 'y') { rl.close(); return; }
    }
  } catch (e) {
    console.log('  ERROR: Run "npm start" once first to create the database tables, then run setup.');
    rl.close(); return;
  }

  // ===== ADMIN ACCOUNT =====
  console.log('  --- Head Office Admin (Root) ---');
  const adminUser = 'root';
  const adminPass = 'admin@123';
  const adminName = 'Head Office Admin';

  try {
    db.prepare('INSERT OR REPLACE INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      'admin001', adminUser, adminPass, adminName, 'headoffice', null
    );
    console.log(`  ✅ Admin: ${adminUser} / ${adminPass}\n`);
  } catch (e) {
    db.prepare('UPDATE users SET password = ?, name = ? WHERE username = ?').run(adminPass, adminName, adminUser);
    console.log(`  ✅ Admin updated\n`);
  }

  // ===== LOCKER TYPES =====
  console.log('  --- Setting up Locker Types ---');

  const lockerTypes = [
    {
      id: 'lt_l6_std', name: 'L6', variant: 'Standard', lockers_per_unit: 6,
      unit_h: 2000, unit_w: 1075, unit_d: 700,
      locker_h: 637, locker_w: 529, locker_d: 621,
      weight: 0, is_upcoming: 0, annual_rent: 25000, deposit: 300000,
      desc: 'L6 Hi-Tech Lockers with Wooden Sleepers — 6 lockers per unit'
    },
    {
      id: 'lt_l10_std', name: 'L10', variant: 'Standard', lockers_per_unit: 10,
      unit_h: 2000, unit_w: 1075, unit_d: 575,
      locker_h: 385, locker_w: 530, locker_d: 492,
      weight: 475, is_upcoming: 0, annual_rent: 20000, deposit: 250000,
      desc: 'L2/10 Hi-Tech Lockers with Wooden Sleepers — 10 lockers per unit'
    },
    {
      id: 'lt_l6_ultra', name: 'L6', variant: 'Secunex Ultra', lockers_per_unit: 6,
      unit_h: 2000, unit_w: 1075, unit_d: 700,
      locker_h: 637, locker_w: 529, locker_d: 621,
      weight: 0, is_upcoming: 1, annual_rent: 25000, deposit: 300000,
      desc: 'L6 Secunex Ultra (Silver/Gold facia) with Wooden Sleepers — 6 lockers per unit. UPCOMING.'
    },
    {
      id: 'lt_l10_ultra', name: 'L10', variant: 'Secunex Ultra', lockers_per_unit: 10,
      unit_h: 2000, unit_w: 1075, unit_d: 575,
      locker_h: 385, locker_w: 530, locker_d: 492,
      weight: 475, is_upcoming: 1, annual_rent: 20000, deposit: 250000,
      desc: 'L2/10 Secunex Ultra (Silver/Gold facia) with Wooden Sleepers — 10 lockers per unit. UPCOMING.'
    }
  ];

  const insertType = db.prepare(`INSERT OR IGNORE INTO locker_types (id, name, variant, lockers_per_unit,
    unit_height_mm, unit_width_mm, unit_depth_mm, locker_height_mm, locker_width_mm, locker_depth_mm,
    weight_kg, auto_size, description, is_upcoming, annual_rent, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  lockerTypes.forEach(t => {
    const size = classifySize(t.locker_h, t.locker_w, t.locker_d);
    insertType.run(t.id, t.name, t.variant, t.lockers_per_unit,
      t.unit_h, t.unit_w, t.unit_d, t.locker_h, t.locker_w, t.locker_d,
      t.weight, size, t.desc, t.is_upcoming, t.annual_rent, t.deposit);
    const vol = ((t.locker_h * t.locker_w * t.locker_d) / 1000000).toFixed(1);
    console.log(`  ✅ ${t.name} ${t.variant}: ${t.lockers_per_unit}/unit, ${t.locker_h}×${t.locker_w}×${t.locker_d}mm = ${vol}L → ${size}, Rent: ₹${t.annual_rent.toLocaleString()}, Deposit: ₹${t.deposit.toLocaleString()}${t.is_upcoming ? ' [UPCOMING]' : ''}`);
  });

  // ===== RS PURAM BRANCH =====
  console.log('\n  --- Setting up RS Puram Branch ---');

  const branchId = 'br_rspuram';
  try {
    db.prepare('INSERT INTO branches (id, name, address, phone) VALUES (?, ?, ?, ?)').run(
      branchId, 'RS Puram', '', ''
    );
    db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(branchId);
  } catch (e) { /* already exists */ }

  // Branch user
  const brUser = 'rspuram';
  const brPass = 'admin@123';
  try {
    db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      genId(), brUser, brPass, 'RS Puram Staff', 'branch', branchId
    );
  } catch (e) {
    db.prepare('UPDATE users SET password = ? WHERE username = ?').run(brPass, brUser);
  }
  console.log(`  ✅ Branch: RS Puram — login: ${brUser} / ${brPass}`);

  // ===== CREATE UNITS & LOCKERS =====
  console.log('\n  --- Creating Units & Lockers ---');

  const insertUnit = db.prepare('INSERT OR IGNORE INTO units (id, branch_id, locker_type_id, unit_number, location, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertLocker = db.prepare('INSERT OR IGNORE INTO lockers (id, branch_id, unit_id, locker_type_id, number, size, location, rent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const checkUnit = db.prepare('SELECT id FROM units WHERE id = ?');

  const unitConfigs = [
    // 8 × L6 Standard units
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `unit_l6_${i + 1}`, typeId: 'lt_l6_std', num: `L6-${String(i + 1).padStart(2, '0')}`,
      location: 'RS Puram', status: 'active'
    })),
    // 4 × L10 Standard units
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `unit_l10_${i + 1}`, typeId: 'lt_l10_std', num: `L10-${String(i + 1).padStart(2, '0')}`,
      location: 'RS Puram', status: 'active'
    }))
  ];

  let totalLockers = 0;
  const tx = db.transaction(() => {
    unitConfigs.forEach(u => {
      if (checkUnit.get(u.id)) return; // skip if exists
      const lt = lockerTypes.find(t => t.id === u.typeId);
      const size = classifySize(lt.locker_h, lt.locker_w, lt.locker_d);
      insertUnit.run(u.id, branchId, u.typeId, u.num, u.location, u.status, '');

      for (let i = 1; i <= lt.lockers_per_unit; i++) {
        const lockerNum = `${u.num}-${String(i).padStart(2, '0')}`;
        insertLocker.run(genId(), branchId, u.id, u.typeId, lockerNum, size, u.location, 0, 'vacant');
        totalLockers++;
      }
    });
  });
  tx();

  const l6Count = 8 * 6;
  const l10Count = 4 * 10;
  console.log(`  ✅ L6 Standard: 8 units × 6 lockers = ${l6Count} lockers (Large)`);
  console.log(`  ✅ L10 Standard: 4 units × 10 lockers = ${l10Count} lockers (Medium)`);
  console.log(`  ✅ Total: ${l6Count + l10Count} lockers created at RS Puram`);

  // ===== ADDITIONAL BRANCHES =====
  console.log('');
  const moreBranches = parseInt(await ask('  Add more branches? Enter count (default: 0): ') || '0');

  for (let b = 0; b < moreBranches; b++) {
    console.log(`\n  --- Additional Branch ${b + 1} ---`);
    const bName = await ask('  Branch name: ');
    if (!bName) continue;
    const bAddr = await ask('  Address: ') || '';
    const bUser = await ask(`  Staff username (default: ${bName.toLowerCase().replace(/\s+/g, '')}): `) || bName.toLowerCase().replace(/\s+/g, '');
    const bPass = await ask('  Staff password (default: branch123): ') || 'branch123';

    const bid = genId();
    db.prepare('INSERT INTO branches (id, name, address, phone) VALUES (?, ?, ?, ?)').run(bid, bName, bAddr, '');
    db.prepare('INSERT INTO config (branch_id) VALUES (?)').run(bid);
    try {
      db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(
        genId(), bUser, bPass, bName + ' Staff', 'branch', bid
      );
    } catch (e) {}
    console.log(`  ✅ Branch "${bName}" — login: ${bUser} / ${bPass}`);

    const addUnits = await ask('  Add units to this branch? (y/n, default: n): ');
    if (addUnits.toLowerCase() === 'y') {
      const l6units = parseInt(await ask('    How many L6 Standard units? (default: 0): ') || '0');
      const l10units = parseInt(await ask('    How many L10 Standard units? (default: 0): ') || '0');

      const txB = db.transaction(() => {
        for (let i = 1; i <= l6units; i++) {
          const uid = genId(); const unum = `L6-${String(i).padStart(2, '0')}`;
          insertUnit.run(uid, bid, 'lt_l6_std', unum, bName, 'active', '');
          for (let j = 1; j <= 6; j++) {
            insertLocker.run(genId(), bid, uid, 'lt_l6_std', `${unum}-${String(j).padStart(2, '0')}`, 'Large', bName, 0, 'vacant');
          }
        }
        for (let i = 1; i <= l10units; i++) {
          const uid = genId(); const unum = `L10-${String(i).padStart(2, '0')}`;
          insertUnit.run(uid, bid, 'lt_l10_std', unum, bName, 'active', '');
          for (let j = 1; j <= 10; j++) {
            insertLocker.run(genId(), bid, uid, 'lt_l10_std', `${unum}-${String(j).padStart(2, '0')}`, 'Medium', bName, 0, 'vacant');
          }
        }
      });
      txB();
      console.log(`    ✅ ${l6units * 6 + l10units * 10} lockers created`);
    }
  }

  console.log('\n  ══════════════════════════════════════');
  console.log('  Setup complete! Start the server:');
  console.log('    npm start');
  console.log('  Then open http://localhost:8080');
  console.log('  ══════════════════════════════════════\n');

  rl.close();
  db.close();
}

main().catch(e => { console.error(e); rl.close(); });
