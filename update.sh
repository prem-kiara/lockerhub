#!/bin/bash
# ============================================================
# LockerHub Update Script
# Backs up DB, pulls latest code, restarts server
# Usage: ./update.sh
# ============================================================

set -e
cd "$(dirname "$0")"

echo "========================================="
echo "  LockerHub - Safe Update"
echo "========================================="

# 1. Backup database
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP="data/backups/lockerhub_${TIMESTAMP}.db"
mkdir -p data/backups

if [ -f data/lockerhub.db ]; then
  cp data/lockerhub.db "$BACKUP"
  echo ">>> Database backed up to: $BACKUP"
else
  echo ">>> No existing database found, skipping backup"
fi

# 2. Pull latest code
echo ">>> Pulling latest code from git..."
git pull

# 3. Install any new dependencies
echo ">>> Installing dependencies..."
npm install

# 4. Rebuild native modules (in case Node version changed)
npm rebuild better-sqlite3

# 5. Restart with PM2
echo ">>> Restarting LockerHub..."
pm2 restart lockerhub

echo ""
echo "========================================="
echo "  Update complete!"
echo "  Backup saved: $BACKUP"
echo "  Run 'pm2 logs lockerhub' to check"
echo "========================================="
