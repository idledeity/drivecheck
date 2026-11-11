"""
scripts/set_password.py — Set the drivecheck login username and password.

Usage (from the repo root):
    backend/.venv/bin/python scripts/set_password.py

Writes <data dir>/auth.json (owner-readable only) with a salted scrypt hash of
the password. The running backend picks it up on the next request, no restart
needed, and every existing session is signed out.
"""

import getpass
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "backend"))

from settings import cfg  # noqa: E402
from system_utils import auth, paths  # noqa: E402  (paths registers data.dir)


def main() -> int:
    cfg.load(_REPO / "config.yaml")
    current = auth.load_credentials()
    default_user = current["username"] if current else "admin"

    username = input(f"Username [{default_user}]: ").strip() or default_user
    password = getpass.getpass("New password: ")
    if len(password) < auth.MIN_PASSWORD_LENGTH:
        print(f"Password must be at least {auth.MIN_PASSWORD_LENGTH} characters.", file=sys.stderr)
        return 1
    if getpass.getpass("Repeat password: ") != password:
        print("Passwords don't match.", file=sys.stderr)
        return 1

    auth.save_credentials(username, password)
    print(f"Saved login for {username!r} to {auth.credentials_path()}.")
    if current:
        print("Existing sessions are signed out.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
