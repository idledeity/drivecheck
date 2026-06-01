#!/usr/bin/env bash
# setup-drivecheck.sh
# Dev environment setup for drivecheck on Debian 13
# Run as your normal user (not root) — sudo will be invoked where needed.

set -euo pipefail

PROJECT_DIR="$HOME/projects/drivecheck"

echo "=== [1/5] System packages ==="
sudo apt update
sudo apt install -y \
  python3 python3-pip python3-venv \
  smartmontools \
  e2fsprogs \
  git \
  curl

echo ""
echo "=== [2/5] Node.js 22 (LTS) via NodeSource ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version

echo ""
echo "=== [3/5] Project directory scaffold ==="
mkdir -p "$PROJECT_DIR"/{backend,frontend,reports}
echo "Created $PROJECT_DIR"

echo ""
echo "=== [4/5] Python venv + backend deps ==="
python3 -m venv "$PROJECT_DIR/backend/.venv"
"$PROJECT_DIR/backend/.venv/bin/pip" install --upgrade pip
"$PROJECT_DIR/backend/.venv/bin/pip" install flask pyyaml

echo ""
echo "=== [5/5] Vite + React + TypeScript frontend ==="
cd "$PROJECT_DIR/frontend"
npm create vite@latest . -- --template react-ts <<< $'\n'

# Configure Vite dev server to bind on 0.0.0.0 so it's reachable from outside the VM.
# Also sets a fixed dev port (5173) and enables auto-open=false (no browser on the server).
cat > "$PROJECT_DIR/frontend/vite.config.ts" << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: false,
    // Proxy API calls to Flask during development
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})
EOF

npm install

echo ""
echo "============================================"
echo " Setup complete."
echo ""
echo " Project:  $PROJECT_DIR"
echo ""
echo " To start the Vite dev server:"
echo "   cd $PROJECT_DIR/frontend && npm run dev"
echo "   Then open http://<VM-IP>:5173 in your browser"
echo ""
echo " To activate the Python venv:"
echo "   source $PROJECT_DIR/backend/.venv/bin/activate"
echo "============================================"
