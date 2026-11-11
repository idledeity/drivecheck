"""
tls.py — HTTPS for the backend and the dev server.

HTTPS is on by default. Without a configured certificate, a self-signed one
is created under <data dir>/tls/ on first start (valid for localhost, this
host's name and its LAN address) and replaced when it nears expiry. Browsers
warn about it once; a certificate from your own CA (e.g. mkcert) avoids that
via server.tls_cert / server.tls_key. server.https: false serves plain HTTP,
for running behind a reverse proxy that terminates TLS.

The Vite dev server uses the same certificate. It runs this module
(`python -m system_utils.tls` from backend/, see __main__ below) to learn whether HTTPS is on and where the files
are, which also creates the certificate if the dev server starts first.
"""

import fcntl
import json
import logging
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

from settings import cfg
from system_utils import paths

logger = logging.getLogger(__name__)

cfg.register("server.https",
    default=True, type="bool", label="HTTPS",
    section="Server", description="Serve over HTTPS.",
    tooltip="Without your own certificate, a self-signed one is created in the data "
            "directory, and browsers warn about it on the first visit. Turn this off "
            "only behind a reverse proxy that handles HTTPS: otherwise the password "
            "and session cookie cross the network unencrypted.",
)
cfg.register("server.tls_cert",
    default=None, type="str", label="TLS certificate",
    section="Server", description="Certificate file (PEM). Empty uses a self-signed one.",
    tooltip="Use together with the TLS key, for example a certificate from a local CA "
            "made with mkcert, so browsers don't warn. Relative paths are from the "
            "repository root.",
)
cfg.register("server.tls_key",
    default=None, type="str", label="TLS key",
    section="Server", description="Private key file (PEM) for the TLS certificate.",
)

# Apple platforms reject TLS certificates valid for more than 825 days, even
# self-signed ones. Replace the generated one when under 30 days remain.
CERT_DAYS = 825
RENEW_BEFORE_SECONDS = 30 * 24 * 3600

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class TlsConfigError(Exception):
    """The configured certificate or key can't be used."""


def enabled() -> bool:
    return bool(cfg.get("server.https"))


def tls_dir() -> Path:
    return paths.data_dir() / "tls"


def certificate_files() -> tuple[str, str] | None:
    """(cert, key) paths to serve with, or None when HTTPS is off. Creates or renews
    the self-signed certificate when no certificate is configured."""
    if not enabled():
        return None
    cert, key = cfg.get("server.tls_cert"), cfg.get("server.tls_key")
    files = _configured_files(cert, key) if cert or key else ensure_self_signed(tls_dir())
    return str(files[0]), str(files[1])


def _configured_files(cert: str | None, key: str | None) -> tuple[Path, Path]:
    if not (cert and key):
        raise TlsConfigError("set both server.tls_cert and server.tls_key, or neither")
    files = (_PROJECT_ROOT / cert).resolve(), (_PROJECT_ROOT / key).resolve()
    for f in files:
        if not f.is_file():
            raise TlsConfigError(f"TLS file not found: {f}")
    return files


def ensure_self_signed(directory: Path) -> tuple[Path, Path]:
    """The self-signed cert and key in directory, created or renewed as needed.
    A lock keeps the backend and the dev server from both writing one."""
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    cert, key = directory / "cert.pem", directory / "key.pem"
    with open(directory / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (key.is_file() and _valid_for_a_while(cert)):
            _generate(cert, key)
    return cert, key


def _valid_for_a_while(cert: Path) -> bool:
    if not cert.is_file():
        return False
    result = subprocess.run(
        ["openssl", "x509", "-checkend", str(RENEW_BEFORE_SECONDS), "-noout", "-in", str(cert)],
        capture_output=True,
    )
    return result.returncode == 0


def _generate(cert: Path, key: Path) -> None:
    names = subject_alt_names()
    logger.info("creating a self-signed TLS certificate for %s", ", ".join(names))
    # Written beside the final files and renamed over them, so nobody reads
    # a half-written file.
    with tempfile.TemporaryDirectory(dir=cert.parent) as tmp:
        tmp_cert, tmp_key = Path(tmp) / "cert.pem", Path(tmp) / "key.pem"
        result = subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "ec",
             "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
             "-keyout", str(tmp_key), "-out", str(tmp_cert),
             "-days", str(CERT_DAYS), "-subj", "/CN=drivecheck",
             "-addext", "subjectAltName=" + ",".join(names),
             # A server certificate, not a CA: Firefox refuses a CA
             # certificate presented by a server.
             "-addext", "basicConstraints=critical,CA:FALSE",
             "-addext", "keyUsage=critical,digitalSignature",
             "-addext", "extendedKeyUsage=serverAuth"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise TlsConfigError(f"openssl couldn't create a certificate: {result.stderr.strip()}")
        os.chmod(tmp_key, 0o600)
        os.replace(tmp_key, key)
        os.replace(tmp_cert, cert)


def subject_alt_names() -> list[str]:
    """Names the certificate is valid for: localhost, this host, its LAN address."""
    host = socket.gethostname()
    dns = ["localhost", host]
    if "." not in host:
        dns.append(f"{host}.local")
    ips = ["127.0.0.1", "::1"]
    lan = _lan_address()
    if lan and lan not in ips:
        ips.append(lan)
    return [f"DNS:{d}" for d in dns] + [f"IP:{i}" for i in ips]


def _lan_address() -> str | None:
    """The address this host reaches the network from. connect() on a UDP
    socket only picks a route; nothing is sent."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1, never routed anywhere real
            return s.getsockname()[0]
    except OSError:
        return None


def _print_dev_server_config() -> int:
    """For frontend/vite.config.ts: print {"https": bool, "cert": path, "key": path}."""
    cfg.load(_PROJECT_ROOT / "config.yaml")
    try:
        files = certificate_files()
    except TlsConfigError as e:
        print(f"drivecheck TLS: {e}", file=sys.stderr)
        return 1
    out = {"https": False} if files is None else {"https": True, "cert": files[0], "key": files[1]}
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(_print_dev_server_config())
