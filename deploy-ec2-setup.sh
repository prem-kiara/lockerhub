#!/bin/bash
# ============================================================
# LockerHub EC2 Setup Script
# Run this AFTER SSH-ing into your new EC2 instance
# ============================================================

set -e

echo "========================================="
echo "  LockerHub - EC2 Server Setup"
echo "========================================="

# Update system
echo ">>> Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y

# Install Node.js 20 LTS
echo ">>> Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install build tools (needed for better-sqlite3)
echo ">>> Installing build tools..."
sudo apt-get install -y build-essential python3 git

# Install PM2 globally (keeps your app running 24/7)
echo ">>> Installing PM2 process manager..."
sudo npm install -g pm2

# Clone your repo (replace with your actual repo URL)
echo ">>> Cloning LockerHub..."
cd /home/ubuntu
if [ -d "LockerHub" ]; then
  echo "LockerHub directory already exists, pulling latest..."
  cd LockerHub && git pull
else
  echo "IMPORTANT: Replace the URL below with your actual Git repo URL"
  echo "Run: git clone https://github.com/YOUR_USERNAME/LockerHub.git"
  echo "Then: cd LockerHub"
  exit 1
fi

# Install dependencies
echo ">>> Installing dependencies..."
npm install

# Rebuild native modules
echo ">>> Rebuilding better-sqlite3..."
npm rebuild better-sqlite3

# Start with PM2
echo ">>> Starting LockerHub with PM2..."
pm2 start server.js --name lockerhub
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo ""
echo "========================================="
echo "  LockerHub is running!"
echo "  Access: http://YOUR_EC2_PUBLIC_IP:8080"
echo "  PM2 commands:"
echo "    pm2 status        - Check status"
echo "    pm2 logs lockerhub - View logs"
echo "    pm2 restart lockerhub - Restart"
echo "========================================="
