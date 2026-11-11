import os
import stat
import subprocess

import pytest

from settings import cfg
from system_utils import tls


@pytest.fixture(autouse=True)
def fresh_cfg(monkeypatch):
    monkeypatch.setattr(cfg, "_values", dict(cfg._values))


def _cert_text(cert: str) -> str:
    return subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-text"],
                          capture_output=True, text=True, check=True).stdout


def test_https_off_serves_plain_http():
    cfg.set("server.https", False)
    assert tls.certificate_files() is None


def test_creates_a_self_signed_server_certificate(isolated_data_dir):
    cert, key = tls.certificate_files()

    assert cert == str(isolated_data_dir / "tls" / "cert.pem")
    assert key == str(isolated_data_dir / "tls" / "key.pem")
    assert stat.S_IMODE(os.stat(key).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(isolated_data_dir / "tls").st_mode) == 0o700
    text = _cert_text(cert)
    assert "DNS:localhost" in text
    assert "IP Address:127.0.0.1" in text
    assert "CA:FALSE" in text


def test_reuses_the_certificate_while_it_is_valid():
    cert, _ = tls.certificate_files()
    before = open(cert).read()
    tls.certificate_files()
    assert open(cert).read() == before


def test_replaces_a_certificate_that_is_about_to_expire(monkeypatch):
    monkeypatch.setattr(tls, "CERT_DAYS", 1)  # inside the 30-day renewal window
    cert, _ = tls.certificate_files()
    first = open(cert).read()

    monkeypatch.setattr(tls, "CERT_DAYS", 825)
    tls.certificate_files()
    assert open(cert).read() != first


def test_extra_names_are_added_to_the_certificate():
    cfg.set("server.tls_extra_names", ["203.0.113.7", "drivecheck.example.net", "not a name!"])
    cert, _ = tls.certificate_files()
    text = _cert_text(cert)
    assert "IP Address:203.0.113.7" in text
    assert "DNS:drivecheck.example.net" in text
    assert "not a name" not in text


def test_replaces_a_certificate_that_does_not_cover_a_new_name():
    cert, _ = tls.certificate_files()
    first = open(cert).read()

    cfg.set("server.tls_extra_names", ["203.0.113.7"])
    tls.certificate_files()
    assert open(cert).read() != first
    assert "IP Address:203.0.113.7" in _cert_text(cert)

    second = open(cert).read()
    tls.certificate_files()  # covered now, so kept
    assert open(cert).read() == second


def test_replaces_a_certificate_whose_key_is_missing():
    cert, key = tls.certificate_files()
    first = open(cert).read()
    os.remove(key)
    tls.certificate_files()
    assert os.path.isfile(key)
    assert open(cert).read() != first


def test_uses_a_configured_certificate(tmp_path):
    cert, key = tmp_path / "mine.pem", tmp_path / "mine.key"
    cert.write_text("cert")
    key.write_text("key")
    cfg.set("server.tls_cert", str(cert))
    cfg.set("server.tls_key", str(key))

    assert tls.certificate_files() == (str(cert), str(key))
    assert not (tmp_path / "tls").exists()


def test_a_configured_certificate_needs_its_key(tmp_path):
    cert = tmp_path / "mine.pem"
    cert.write_text("cert")
    cfg.set("server.tls_cert", str(cert))
    with pytest.raises(tls.TlsConfigError, match="both"):
        tls.certificate_files()


def test_a_missing_configured_file_is_an_error(tmp_path):
    cfg.set("server.tls_cert", str(tmp_path / "nope.pem"))
    cfg.set("server.tls_key", str(tmp_path / "nope.key"))
    with pytest.raises(tls.TlsConfigError, match="not found"):
        tls.certificate_files()
