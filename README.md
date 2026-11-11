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

3. Set the login password (the API refuses every request until one is set):

   ```sh
   backend/.venv/bin/python scripts/set_password.py
   ```

   This writes `data/auth.json` (owner-readable only). Re-run it any time to
   change the password; that signs out every existing session.

4. Start the backend:

   ```sh
   source backend/.venv/bin/activate
   cd backend && python app.py
   ```

   Flask runs on port 4343 (see `config.yaml`).

5. Start the frontend dev server:

   ```sh
   cd frontend && npm run dev
   ```

   Open `https://<host-ip>:5173` — API requests are proxied to the backend.

Both servers use HTTPS. On first start the backend creates a self-signed
certificate in `data/tls/` (valid for `localhost`, the host name and its LAN
address), so each browser warns once before you continue to the site. To
avoid the warning, point `server.tls_cert` and `server.tls_key` in
`config.yaml` at a certificate your browsers trust, for example one from
[mkcert](https://github.com/FiloSottile/mkcert). Set `server.https: false`
only behind a reverse proxy that handles HTTPS. Without HTTPS, the password
and session cookie cross the network unencrypted.

If the host's address changes, delete `data/tls/` and restart to get a
certificate for the new address.

A VS Code workspace is included (`.vscode/`) with launch configs and tasks
for running/debugging both the backend and frontend together.

## Testing

```sh
cd backend && .venv/bin/python -m pytest -v   # backend
cd frontend && npm test                       # frontend
```

Or from VS Code: Command Palette → "Run Task" → `Backend Tests`,
`Frontend Tests`, or `Test All` (runs both).

For frontend tests, the [Vitest VS Code extension](https://marketplace.visualstudio.com/items?itemName=vitest.explorer)
is optional but gives inline pass/fail and per-test debugging in the Testing
sidebar — it auto-detects the `test` config in `frontend/vite.config.ts`.
