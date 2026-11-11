import pytest
from flask import Flask

from system_utils import origin_guard


@pytest.fixture
def client():
    app = Flask(__name__)
    origin_guard.install(app)

    @app.route("/api/thing", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def thing():
        return {"ok": True}

    return app.test_client()


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_a_write_from_another_site_is_refused(client, method):
    res = client.open("/api/thing", method=method, headers={"Origin": "https://evil.example"})
    assert res.status_code == 403
    assert res.get_json() == {"error": "cross-origin request refused"}


@pytest.mark.parametrize("origin", [
    "http://localhost:8080",   # another app on the same machine, different port
    "http://127.0.0.1",        # same machine, different host spelling
    "null",                    # sandboxed iframe or file:// page
])
def test_near_misses_are_refused_too(client, origin):
    res = client.post("/api/thing", headers={"Origin": origin}, base_url="http://localhost")
    assert res.status_code == 403


def test_a_same_origin_write_is_allowed(client):
    res = client.post("/api/thing", headers={"Origin": "http://localhost:5173"}, base_url="http://localhost:5173")
    assert res.status_code == 200


def test_the_host_comparison_ignores_case(client):
    res = client.post("/api/thing", headers={"Origin": "http://LocalHost:5173"}, base_url="http://localhost:5173")
    assert res.status_code == 200


def test_a_write_without_an_origin_is_allowed(client):
    # curl and scripts don't send Origin; browsers always do on cross-origin writes.
    assert client.post("/api/thing").status_code == 200


def test_reads_are_never_checked(client):
    assert client.get("/api/thing", headers={"Origin": "https://evil.example"}).status_code == 200
