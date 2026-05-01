"""
Kente's Korner — security helpers.

Stand-alone, dependency-free guards extracted from kente-server.py so they
can be unit-tested in isolation.  Stdlib only — kente-server.py is
intentionally pip-free.

Exposed functions:
    origin_allowed(origin_header) -> bool
    safe_resolve(base_dir, url_path) -> Path | None
"""
import urllib.parse
from pathlib import Path


# Hostnames considered "local" for the CSRF guard.  IPv6 loopback and the
# bare hostname are accepted alongside IPv4.
_LOCAL_HOSTS = frozenset({'localhost', '127.0.0.1', '::1'})


def origin_allowed(origin_header):
    """Return True if the request's Origin header is acceptable for a
    state-changing endpoint.

    Policy:
      - Missing / empty Origin (curl, Electron preload, server-to-server) is
        allowed; the kente-server is bound to 127.0.0.1 so unprivileged
        non-browser clients on this host are trusted.
      - Anything with an Origin must resolve to a localhost hostname.
      - Malformed Origin headers are rejected.
    """
    if not origin_header:
        return True
    try:
        host = urllib.parse.urlparse(origin_header).hostname or ''
    except Exception:
        return False
    return host in _LOCAL_HOSTS


def safe_resolve(base_dir, url_path):
    """Resolve a URL path against `base_dir` and reject path-traversal.

    Returns the resolved Path on success, or None if the request escapes the
    base directory (the caller should respond 403).  The path is URL-decoded
    before resolution so "Conceptual%20Artifacts/foo" maps to disk correctly.

    The check is purely string-based on resolved paths, so symlinks pointing
    outside the base will *also* be rejected because Path.resolve() follows
    them before comparison.
    """
    base = Path(base_dir).resolve()
    decoded = urllib.parse.unquote(url_path or '').lstrip('/')
    try:
        candidate = (base / decoded).resolve()
    except (OSError, ValueError):
        return None
    base_s = str(base)
    cand_s = str(candidate)
    # Require the resolved path to live under base_dir.  The trailing
    # separator check prevents "/srv/web-evil" from being accepted when
    # base is "/srv/web".
    import os
    if cand_s == base_s:
        return candidate
    sep = os.sep
    if cand_s.startswith(base_s + sep):
        return candidate
    return None
