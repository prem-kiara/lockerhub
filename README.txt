╔══════════════════════════════════════════════════════╗
║          LockerHub - Setup Instructions              ║
╚══════════════════════════════════════════════════════╝

STEP 1: Install Node.js
────────────────────────
Download and install from: https://nodejs.org
(Choose the LTS version)


STEP 2: First-Time Setup
─────────────────────────
Windows:
  1. Copy the entire LockerHub folder to C:\LockerHub (or anywhere)
  2. Double-click "start.bat"
  3. It will install dependencies and run the setup wizard
  4. Follow the prompts to create admin account and branches

Mac/Linux:
  1. Copy LockerHub folder wherever you like
  2. Open Terminal, navigate to the folder
  3. Run: chmod +x start.sh && ./start.sh
  4. Follow the setup wizard


STEP 3: Setup Wizard
─────────────────────
The wizard will ask you to:
  - Create a Head Office admin account (username + password)
  - Create branches (name, address, login credentials)
  - Auto-create 200 lockers per branch (optional)


STEP 4: Access the System
──────────────────────────
  - On this computer: http://localhost:8080
  - From other computers on same network: http://<this-pc-ip>:8080

To find your PC's IP address:
  Windows: Open cmd → type "ipconfig" → look for IPv4 Address
  Mac/Linux: Open terminal → type "ifconfig" or "ip addr"


STEP 5: Branch Access
──────────────────────
Give each branch the URL (http://<server-ip>:8080) and their
login credentials. They open it in any browser — Chrome, Edge,
Firefox, or even on a mobile phone.


DAILY USAGE:
────────────
  Windows: Double-click start.bat each morning
  Mac/Linux: Run ./start.sh

  The server must be running for branches to access the system.
  Keep the terminal/command prompt window open.


FOR PERMANENT BACKGROUND RUNNING:
──────────────────────────────────
  Install PM2 (process manager):
    npm install -g pm2
    pm2 start server.js --name lockerhub
    pm2 save
    pm2 startup    (follow the instructions shown)

  This makes LockerHub start automatically when the PC boots up.


BACKUP:
───────
  - Database file: data/lockerhub.db (copy this file for backup)
  - Full backup via app: Login as admin → Data & Backup → Download
  - Recommended: Take backup weekly


ACCESSING FROM OUTSIDE YOUR NETWORK (OPTIONAL):
────────────────────────────────────────────────
If branches are in different locations (not on same Wi-Fi/LAN):

  Option A: Use a cloud server (DigitalOcean/AWS/Hostinger)
    - Get a basic VPS (~₹500/month)
    - Install Node.js on the server
    - Upload LockerHub folder
    - Run: npm install && npm start
    - Access via the server's public IP

  Option B: Use a tunneling service
    - Install ngrok (https://ngrok.com)
    - Run: ngrok http 8080
    - Share the ngrok URL with branches
    - Free tier has limitations; paid is ~₹800/month

  Option C: Port forwarding on your router
    - Forward port 8080 to your PC's local IP
    - Share your public IP with branches
    - Requires a static IP or Dynamic DNS service


TROUBLESHOOTING:
────────────────
  Q: "Cannot connect from other computers"
  A: Check Windows Firewall — allow Node.js through firewall
     Or allow port 8080: netsh advfirewall firewall add rule
     name="LockerHub" dir=in action=allow protocol=tcp localport=8080

  Q: "npm install fails"
  A: Try running command prompt as Administrator
     On Linux: sudo npm install

  Q: "Port 8080 already in use"
  A: Change PORT in server.js, or close the other application

  Q: "Forgot admin password"
  A: Run: node setup.js (will let you reset password)
