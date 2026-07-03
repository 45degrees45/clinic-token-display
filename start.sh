#!/data/data/com.termux/files/usr/bin/bash

# ─── Clinic Token Display — Startup Script ───────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Clinic Token Display System        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
  echo "Installing packages (first run only)..."
  npm install
  echo ""
fi

# Get local IP
IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
if [ -z "$IP" ]; then
  IP=$(ip route get 8.8.8.8 2>/dev/null | awk '/src/{print $7}')
fi
PORT=$(node -e "try{const c=require('./config.json');console.log(c.port||3000)}catch(e){console.log(3000)}")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -n "$IP" ]; then
  echo "  TV Display  : http://$IP:$PORT/"
  echo "  Admin       : http://$IP:$PORT/admin"
  echo "  Patient     : http://$IP:$PORT/patient"
else
  echo "  (Connect to WiFi first, then check IP)"
  echo "  Admin       : http://localhost:$PORT/admin"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Press Ctrl+C to stop the server."
echo ""

node server.js
