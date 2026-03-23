#!/bin/bash
echo ""
echo "  LockerHub - Locker Management System"
echo "  ====================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js is not installed!"
    echo "  Install it: sudo apt install nodejs npm"
    echo "  Or download from: https://nodejs.org"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies (first time only)..."
    npm install
    echo ""
fi

# Run setup if no database exists
if [ ! -f "data/lockerhub.db" ]; then
    echo "  First run detected!"
    echo "  Starting server in background..."
    node server.js &
    SERVER_PID=$!
    sleep 2
    echo ""
    echo "  Running setup wizard..."
    node setup.js
    echo ""
    echo "  Server is running (PID: $SERVER_PID)"
    echo "  Open http://localhost:8080 in your browser."
    wait $SERVER_PID
else
    echo "  Starting server..."
    node server.js
fi
