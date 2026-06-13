# drivecheck
A browser-based drive health evaluation tool. The core use case is vetting hard drives before trusting them with data. Supports running SMART tests, collecting SMART attributes, optionally running badblocks, and producing a report. Distinct from passive monitoring tools like Scrutiny; this is an active evaluation and triage workflow.

## Development setup

Requires a Debian/Ubuntu (apt-based) host.

1. Clone the repo and run the setup script:

   ```sh
   git clone <repo-url> drivecheck
   cd drivecheck
   ./scripts/setup-dev-env.sh
   ```

   This installs system packages (Python, smartmontools, e2fsprogs, Node 22),
   creates the backend Python venv, installs frontend dependencies, and grants
   the `drivecheck` group passwordless `sudo smartctl` access (needed by the
   backend to read SMART data).

2. Log out and back in (or run `newgrp drivecheck`) so the group membership
   from step 1 takes effect.

3. Start the backend:

   ```sh
   source backend/.venv/bin/activate
   cd backend && python app.py
   ```

   Flask runs on port 4343 (see `config.yaml`).

4. Start the frontend dev server:

   ```sh
   cd frontend && npm run dev
   ```

   Open `http://<host-ip>:5173` — API requests are proxied to the backend.

A VS Code workspace is included (`.vscode/`) with launch configs and tasks
for running/debugging both the backend and frontend together.
