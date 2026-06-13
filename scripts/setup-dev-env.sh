#!/usr/bin/env bash
# setup-dev-env.sh
# Dev environment setup for drivecheck on Debian/Ubuntu (apt-based).
# Run from within a clone of this repo, as your normal user (not root) —
# sudo will be invoked where needed.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
echo "=== [3/5] Python venv + backend deps ==="
python3 -m venv "$REPO_DIR/backend/.venv"
"$REPO_DIR/backend/.venv/bin/pip" install --upgrade pip
"$REPO_DIR/backend/.venv/bin/pip" install flask pyyaml

echo ""
echo "=== [4/5] Frontend dependencies ==="
cd "$REPO_DIR/frontend"
npm install

echo ""
echo "=== [5/5] Passwordless sudo for smartctl (drivecheck group) ==="
# The backend shells out to `sudo smartctl` to read SMART data; without this
# rule it would hang waiting for a password when invoked by the Flask server.
# Granted to a group rather than this user directly so the same rule covers
# a dedicated service account when running drivecheck as a daemon.
SMARTCTL_PATH="/usr/sbin/smartctl"
SUDOERS_FILE="/etc/sudoers.d/drivecheck-smartctl"
sudo groupadd -f drivecheck
sudo usermod -aG drivecheck "$(whoami)"
echo "%drivecheck ALL=(root) NOPASSWD: $SMARTCTL_PATH" | sudo tee "$SUDOERS_FILE" > /dev/null
sudo chmod 440 "$SUDOERS_FILE"
sudo visudo -cf "$SUDOERS_FILE"

echo ""
echo "============================================"
echo " Setup complete."
echo ""
echo " Project:  $REPO_DIR"
echo ""
echo " You were added to the 'drivecheck' group — log out and back in"
echo " (or run 'newgrp drivecheck') for this to take effect."
echo ""
echo " To start the backend (Flask, port 4343):"
echo "   source $REPO_DIR/backend/.venv/bin/activate"
echo "   cd $REPO_DIR/backend && python app.py"
echo ""
echo " To start the Vite dev server (proxies /api to the backend):"
echo "   cd $REPO_DIR/frontend && npm run dev"
echo "   Then open http://<host-ip>:5173 in your browser"
echo "============================================"
