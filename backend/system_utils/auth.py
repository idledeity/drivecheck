"""
system_utils.auth — single-user login for the API.

Credentials live in <data dir>/auth.json ({"username", "password_hash"}), written
by scripts/set_password.py, not in config.yaml: that file is tracked in git, and
cfg.save() rewrites it from the copy loaded at startup, which would silently
undo a password set while the backend runs. auth.json is re-read on each request
(it's tiny), so a new password applies without a restart.

  - No credentials yet: every guarded route returns 401 and /api/auth/status
    reports configured=false, so the UI explains how to set a password.
  - Sessions are Flask's signed cookie (HttpOnly, SameSite=Strict, 30 days),
    signed with a random key kept in <data dir>/secret_key.
  - A session carries a fingerprint of the password hash, so setting a new
    password signs out every existing session.
  - After _FREE_FAILURES failed logins, each further attempt must wait an
    increasing delay (capped at _MAX_DELAY seconds). In memory only: enough for
    a single-user LAN tool, and a restart is visible in the log anyway.
"""

import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from datetime import timedelta
from pathlib import Path

from flask import Blueprint, Flask, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from system_utils import paths

logger = logging.getLogger(__name__)

_CREDENTIALS_FILE = "auth.json"
_SECRET_KEY_FILE = "secret_key"
SESSION_LIFETIME = timedelta(days=30)
MIN_PASSWORD_LENGTH = 8

# Reachable without a session: the UI needs them to find out it must log in.
_OPEN_PATHS = {"/api/auth/status", "/api/auth/login", "/api/auth/logout"}

_FREE_FAILURES = 5
_MAX_DELAY = 30.0

bp = Blueprint("auth", __name__)


# ---------------------------------------------------------------------------
# Credentials and secret key
# ---------------------------------------------------------------------------

def credentials_path() -> Path:
    return paths.data_dir() / _CREDENTIALS_FILE


def load_credentials() -> dict | None:
    """Return {"username", "password_hash"}, or None if no password is set."""
    path = credentials_path()
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        logger.error("cannot read %s, treating as no password set: %s", path, e)
        return None
    if not isinstance(data, dict) or not data.get("username") or not data.get("password_hash"):
        logger.error("%s is missing username or password_hash, treating as no password set", path)
        return None
    return {"username": str(data["username"]), "password_hash": str(data["password_hash"])}


def save_credentials(username: str, password: str) -> None:
    """Hash password and write the credentials file, readable by its owner only."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LENGTH} characters")
    if not username:
        raise ValueError("username must not be empty")
    data = {"username": username, "password_hash": generate_password_hash(password)}
    _write_private(credentials_path(), json.dumps(data, indent=2).encode() + b"\n")


def _write_private(path: Path, content: bytes) -> None:
    """Write content to path atomically, created with mode 0600."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(content)
    os.replace(tmp, path)


def _secret_key() -> bytes:
    """The session signing key, generated on first use."""
    path = paths.data_dir() / _SECRET_KEY_FILE
    try:
        key = path.read_bytes()
        if len(key) >= 32:
            return key
        logger.warning("%s is too short, generating a new one", path)
    except FileNotFoundError:
        pass
    key = secrets.token_bytes(32)
    _write_private(path, key)
    logger.info("generated a new session secret key in %s", path)
    return key


def _fingerprint(password_hash: str) -> str:
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Failed-login throttle
# ---------------------------------------------------------------------------

class _Throttle:
    def __init__(self):
        self._lock = threading.Lock()
        self._failures = 0
        self._last_failure = 0.0

    def wait_seconds(self) -> float:
        """Seconds until another attempt is allowed (0 if allowed now)."""
        with self._lock:
            if self._failures < _FREE_FAILURES:
                return 0.0
            delay = min(_MAX_DELAY, 2.0 ** (self._failures - _FREE_FAILURES + 1))
            return max(0.0, self._last_failure + delay - time.monotonic())

    def failed(self) -> None:
        with self._lock:
            self._failures += 1
            self._last_failure = time.monotonic()

    def reset(self) -> None:
        with self._lock:
            self._failures = 0


_throttle = _Throttle()


# ---------------------------------------------------------------------------
# Flask wiring
# ---------------------------------------------------------------------------

def install(app: Flask) -> None:
    """Configure sessions on app, guard /api/*, and add the /api/auth routes."""
    app.secret_key = _secret_key()
    app.config.update(
        SESSION_COOKIE_NAME="drivecheck_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        PERMANENT_SESSION_LIFETIME=SESSION_LIFETIME,
    )
    app.before_request(_require_login)
    app.register_blueprint(bp)


def current_user() -> str | None:
    """The signed-in username, or None. Re-checks against the current credentials."""
    creds = load_credentials()
    if creds is None:
        return None
    user = session.get("user")
    fp = session.get("fp")
    if not isinstance(user, str) or not isinstance(fp, str):
        return None
    if not hmac.compare_digest(user, creds["username"]):
        return None
    if not hmac.compare_digest(fp, _fingerprint(creds["password_hash"])):
        return None
    return user


def _require_login():
    if not request.path.startswith("/api/") or request.path in _OPEN_PATHS:
        return None
    if current_user() is None:
        return jsonify({"error": "login required"}), 401
    return None


@bp.get("/api/auth/status")
def status():
    user = current_user()
    return jsonify({
        "configured": load_credentials() is not None,
        "authenticated": user is not None,
        "username": user,
    })


@bp.post("/api/auth/login")
def login():
    creds = load_credentials()
    if creds is None:
        return jsonify({"error": "no password is set — run scripts/set_password.py on the server"}), 503

    wait = _throttle.wait_seconds()
    if wait > 0:
        retry_after = int(wait) + 1
        return jsonify({"error": f"too many failed attempts — try again in {retry_after}s",
                        "retry_after": retry_after}), 429

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "body must be a JSON object"}), 400
    username = body.get("username")
    password = body.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        return jsonify({"error": "'username' and 'password' are required"}), 400

    # Check the password even when the username is wrong, so the response time
    # doesn't reveal which of the two was right.
    password_ok = check_password_hash(creds["password_hash"], password)
    username_ok = hmac.compare_digest(username, creds["username"])
    if not (password_ok and username_ok):
        _throttle.failed()
        logger.warning("failed login for %r from %s", username, request.remote_addr)
        return jsonify({"error": "wrong username or password"}), 401

    _throttle.reset()
    session.clear()
    session.permanent = True
    session["user"] = creds["username"]
    session["fp"] = _fingerprint(creds["password_hash"])
    logger.info("login: %s from %s", creds["username"], request.remote_addr)
    return jsonify({"authenticated": True, "username": creds["username"]})


@bp.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify({"authenticated": False})
