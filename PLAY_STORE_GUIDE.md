# LockerHub — Play Store Submission Guide

Everything you need to copy-paste into Google Play Console.

---

## STORE LISTING

### App Name
```
LockerHub
```

### Short Description (80 chars max)
```
Manage safe deposit locker rentals, tenants, payments & agreements digitally.
```

### Full Description
```
LockerHub is a comprehensive safe deposit locker management system built for Dhanam Investment and Finance Private Limited.

Designed for locker facility operators, LockerHub streamlines every aspect of locker rental management — from customer onboarding to payment tracking and digital agreements.

KEY FEATURES:

Branch Management
Manage multiple branch locations with individual locker inventories. Each branch maintains its own set of lockers, tenants, and staff.

Locker & Tenant Management
Track locker availability, sizes, and assignments. Maintain detailed tenant profiles with KYC documents including Aadhaar, PAN, and address verification.

Digital Agreements & E-Sign
Generate rental agreements digitally and collect e-signatures via Digio integration. No more paper-based workflows.

Payment & Rent Tracking
Record rent payments, security deposits, and track overdue amounts. Get a clear view of financial status across all branches.

Nominee & Joint Holder Support
Add nominees and joint holders to locker accounts with complete documentation.

Activity Logs & Audit Trail
Every action is logged for compliance and audit purposes. Track who did what and when.

Role-Based Access
Admin, branch manager, and staff roles ensure the right people have the right access.

Dashboard & Reports
Visual dashboard with key metrics — occupancy rates, revenue, overdue payments, and more.

Built with security at its core — all data is encrypted in transit, passwords are hashed, and sessions are protected with JWT authentication.

Developed by Dhanam Investment and Finance Private Limited, Coimbatore, Tamil Nadu.
```

---

## APP CONTENT SECTIONS

### Privacy Policy URL
```
https://lockers.dhanamfinance.com/privacy
```

### Account Deletion URL
```
https://lockers.dhanamfinance.com/delete-account
```

---

## DATA SAFETY FORM — Answers

**Does your app collect or share any of the required user data types?** → Yes

### Data Collected:

| Data Type | Collected | Shared | Purpose | Optional? |
|-----------|-----------|--------|---------|-----------|
| Name | Yes | No | App functionality, Account management | No |
| Email address | Yes | No | App functionality, Account management | No |
| Phone number | Yes | No | App functionality, Account management | No |
| Address | Yes | No | App functionality (KYC) | No |
| Government ID (Aadhaar, PAN) | Yes | Yes (Digio for e-sign) | App functionality (KYC, agreements) | No |

### Security:
- **Is data encrypted in transit?** → Yes
- **Do you provide a way for users to request data deletion?** → Yes
- **Deletion URL:** `https://lockers.dhanamfinance.com/delete-account`

### Data shared with third parties:
- **Digio** (e-signature service) — receives name and document details for agreement signing only

---

## CONTENT RATING (IARC)

Answer the questionnaire as follows:
- Violence: No
- Sexual content: No
- Language: No
- Controlled substances: No
- User interaction: No (users don't interact with each other)
- Location sharing: No
- Personal data handling: Yes

Result will be: **Everyone** or **Rated for 3+**

---

## TARGET AUDIENCE

- **Target age group:** 18 and over
- **Does the app contain ads?** → No
- **Is this a news app?** → No
- **Government apps?** → No

---

## APP ACCESS (Test Credentials)

**Does your app require login?** → Yes — All or some functionality

Provide these credentials:
- **Username:** `googlereviewer`
- **Password:** `Review@2026`
- **Instructions:** "Log in with the credentials above. The app provides locker management features for branch staff. You can view the dashboard, locker inventory, and tenant management sections."

---

## COUNTRIES & PRICING

- **Countries:** India (add more if needed)
- **Pricing:** Free

---

## EC2 COMMANDS — Run These Before Submitting

### 1. Pull latest code & restart
```bash
cd ~/LockerHub
git pull origin main
pm2 restart lockerhub
```

### 2. Recreate database (if deleted)
```bash
node setup.js
```

### 3. Create Google reviewer test account
```bash
node -e "
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = new Database('./data/lockerhub.db');
const hash = bcrypt.hashSync('Review@2026', 10);
const id = uuidv4();
db.prepare('INSERT INTO users (id, username, password, name, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'googlereviewer', hash, 'Google Reviewer', 'branch', null);
console.log('Created test account: googlereviewer / Review@2026');
"
```

### 4. Verify public pages work
```bash
curl -s https://lockers.dhanamfinance.com/privacy | head -5
curl -s https://lockers.dhanamfinance.com/terms | head -5
curl -s https://lockers.dhanamfinance.com/delete-account | head -5
```

---

## ASSETS TO UPLOAD

| Asset | Size | File |
|-------|------|------|
| App Icon (hi-res) | 512×512 | `android-app/app/playstore-icon.png` |
| Feature Graphic | 1024×500 | `android-app/feature-graphic.png` |
| Signed AAB | — | `android-app/app/release/app-release.aab` |
| Screenshots | Phone size | Take from your test device (minimum 2) |

---

## PLAY CONSOLE WALKTHROUGH

1. Go to **play.google.com/console**
2. **Create app** → Name: LockerHub, Default language: English, App: App, Free, Declarations: accept all
3. **Dashboard** → Complete the setup checklist items one by one:
   - **Store listing** → Paste app name, short desc, full desc, upload icon + feature graphic + screenshots
   - **App content → Privacy policy** → Enter URL
   - **App content → App access** → Add test credentials
   - **App content → Data safety** → Fill using answers above
   - **App content → Content rating** → Complete IARC questionnaire
   - **App content → Target audience** → 18+, no ads
4. **Release → Production → Create new release** → Upload AAB
5. **Review and submit**
