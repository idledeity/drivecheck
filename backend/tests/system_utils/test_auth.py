import json
import os
import stat

import pytest
from flask import Flask

from system_utils import auth


@pytest.fixture(autouse=True)
def fresh_throttle(monkeypatch):
    monkeypatch.setattr(auth, "_throttle", auth._Throttle())


@pytest.fixture
def app():
    # isolated_data_dir (conftest) points paths.data_dir() at this test's tmp_path.
    app = Flask(__name__)
    auth.install(app)

    @app.route("/api/thing", methods=["GET", "POST"])
    def thing():
        return {"ok": True}

    @app.route("/not-api")
    def page():
        return "page"

    return app


@pytest.fixture
def client(app):
    return app.test_client()


def _login(client, username="admin", password="correct horse"):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def test_with_no_password_set_everything_is_locked(client):
    assert client.get("/api/thing").status_code == 401
    assert client.get("/api/auth/status").get_json() == {"configured": False, "authenticated": False, "username": None}
    res = _login(client)
    assert res.status_code == 503
    assert "set_password.py" in res.get_json()["error"]


def test_login_opens_the_api_and_logout_closes_it(client):
    auth.save_credentials("admin", "correct horse")
    assert client.get("/api/thing").status_code == 401

    res = _login(client)
    assert res.status_code == 200
    assert res.get_json() == {"authenticated": True, "username": "admin"}
    assert client.get("/api/thing").status_code == 200
    assert client.post("/api/thing").status_code == 200
    assert client.get("/api/auth/status").get_json() == {"configured": True, "authenticated": True, "username": "admin"}

    client.post("/api/auth/logout")
    assert client.get("/api/thing").status_code == 401


@pytest.mark.parametrize("username, password", [("admin", "wrong password"), ("root", "correct horse")])
def test_a_wrong_username_or_password_is_refused(client, username, password):
    auth.save_credentials("admin", "correct horse")
    res = _login(client, username, password)
    assert res.status_code == 401
    assert res.get_json() == {"error": "wrong username or password"}
    assert client.get("/api/thing").status_code == 401


def test_routes_outside_the_api_are_not_guarded(client):
    assert client.get("/not-api").status_code == 200


def test_the_session_cookie_is_httponly_and_strict(client):
    auth.save_credentials("admin", "correct horse")
    res = _login(client)
    cookie = res.headers["Set-Cookie"]
    assert cookie.startswith("drivecheck_session=")
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and "Expires=" in cookie


def test_setting_a_new_password_signs_out_existing_sessions(client):
    auth.save_credentials("admin", "correct horse")
    _login(client)
    assert client.get("/api/thing").status_code == 200
    auth.save_credentials("admin", "battery staple")
    assert client.get("/api/thing").status_code == 401
    assert _login(client, password="battery staple").status_code == 200


def test_credentials_and_secret_key_are_private_files(app, tmp_path):
    auth.save_credentials("admin", "correct horse")
    for name in ("auth.json", "secret_key"):
        mode = stat.S_IMODE(os.stat(tmp_path / name).st_mode)
        assert mode == 0o600, name
    data = json.loads((tmp_path / "auth.json").read_text())
    assert data["username"] == "admin"
    assert "correct horse" not in data["password_hash"]
    assert data["password_hash"].startswith("scrypt:")


def test_the_secret_key_survives_a_restart(tmp_path):
    first, second = Flask("a"), Flask("b")
    auth.install(first)
    auth.install(second)
    assert first.secret_key == second.secret_key


def test_short_passwords_are_rejected():
    with pytest.raises(ValueError, match="at least 8"):
        auth.save_credentials("admin", "short")


def test_repeated_failures_are_throttled(client, monkeypatch):
    auth.save_credentials("admin", "correct horse")
    clock = [1000.0]
    monkeypatch.setattr(auth.time, "monotonic", lambda: clock[0])
    for _ in range(auth._FREE_FAILURES):
        assert _login(client, password="nope").status_code == 401

    res = _login(client)  # even the right password has to wait now
    assert res.status_code == 429
    assert res.get_json()["retry_after"] == 3

    clock[0] += 2.5
    assert _login(client).status_code == 200  # wait over, success resets the count
    assert _login(client, password="nope").status_code == 401
    assert _login(client, password="nope").status_code == 401  # still within the free attempts


def test_a_broken_credentials_file_locks_rather_than_opens(client, tmp_path):
    (tmp_path / "auth.json").write_text("{not json")
    assert client.get("/api/thing").status_code == 401
    assert client.get("/api/auth/status").get_json()["configured"] is False


def test_session_cookie_is_https_only_by_default(client):
    auth.save_credentials("admin", "correct horse")
    cookie = _login(client).headers["Set-Cookie"]
    assert "Secure" in cookie


def test_session_cookie_can_be_sent_over_plain_http():
    app = Flask(__name__)
    auth.install(app, secure_cookie=False)
    auth.save_credentials("admin", "correct horse")
    cookie = _login(app.test_client()).headers["Set-Cookie"]
    assert "Secure" not in cookie
