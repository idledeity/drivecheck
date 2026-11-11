"""
system_utils.origin_guard — refuse cross-origin writes to the API.

Without it, any web page open in a browser on this machine (or on the LAN, via
the dev server) could POST jobs, config changes or probe files to drivecheck
from the viewer's browser: the browser sends the request even though it won't
let that page read the response.

Every browser sends an Origin header on a cross-origin POST/PUT/PATCH/DELETE,
so a write whose Origin doesn't match the Host it was sent to came from another
site and is refused. A request with no Origin header didn't come from a web
page's fetch or form (curl, scripts) and is let through. Reads aren't checked:
the same-origin policy already keeps other pages from reading the responses.
"""

import logging
from urllib.parse import urlsplit

from flask import Flask, jsonify, request

logger = logging.getLogger(__name__)

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def install(app: Flask) -> None:
    """Register the cross-origin write check on app."""
    app.before_request(_check_origin)


def _check_origin():
    if request.method in _SAFE_METHODS:
        return None
    origin = request.headers.get("Origin")
    if origin is None:
        return None
    # "null" (sandboxed iframes, file:// pages) has no host and never matches.
    if urlsplit(origin).netloc.lower() == request.host.lower():
        return None
    logger.warning("refused cross-origin %s %s from %s", request.method, request.path, origin)
    return jsonify({"error": "cross-origin request refused"}), 403
