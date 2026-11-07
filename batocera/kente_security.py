"""
Kente's Korner — security helpers.

Stand-alone, dependency-free guards extracted from kente-server.py so they
can be unit-tested in isolation.  Stdlib only — kente-server.py is
intentionally pip-free.

Exposed functions:
    origin_allowed(origin_header) -> bool
    safe_resolve(base_dir, url_path) -> Path | None
    public_http_url(url) -> bool
    safe_urlopen(request, timeout=30) -> HTTPResponse
"""
import ipaddress
import http.client
import socket
import urllib.error
import urllib.parse
import urllib.request
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
        parsed = urllib.parse.urlparse(origin_header)
        host = parsed.hostname or ''
        # Origins contain only a scheme and authority. Accessing .port also
        # validates malformed/non-numeric ports without accepting them silently.
        parsed.port
        if (parsed.scheme not in ('http', 'https') or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.params
                or parsed.query or parsed.fragment):
            return False
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


def _public_addresses(host, port):
    """Resolve a hostname and return its IPs only when every result is public."""
    try:
        addresses = [ipaddress.ip_address(host.strip('[]'))]
    except ValueError:
        addresses = [ipaddress.ip_address(item[4][0]) for item in
                     socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
    if not addresses or not all(address.is_global for address in addresses):
        raise ValueError('Host resolves to a non-public IP address')
    return list(dict.fromkeys(str(address) for address in addresses))


def _connect_public(host, port, timeout, source_address):
    last_error = None
    for address in _public_addresses(host, port):
        try:
            return socket.create_connection((address, port), timeout, source_address)
        except OSError as error:
            last_error = error
    raise last_error or OSError('No reachable public address')


def public_http_url(url):
    """Return whether an HTTP(S) URL resolves exclusively to public IPs."""
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        if port != (443 if parsed.scheme == 'https' else 80):
            return False
        host = parsed.hostname.rstrip('.').lower()
        return bool(_public_addresses(host, port))
    except (OSError, ValueError, TypeError):
        return False


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """Connect to a checked IP while preserving the URL hostname for Host."""
    def connect(self):
        if self._tunnel_host:
            raise OSError('HTTP proxies are disabled for protected outbound requests')
        self.sock = _connect_public(self.host, self.port, self.timeout, self.source_address)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Pin the TCP destination after DNS validation and retain TLS hostname checks."""
    def connect(self):
        if self._tunnel_host:
            raise OSError('HTTP proxies are disabled for protected outbound requests')
        raw = _connect_public(self.host, self.port, self.timeout, self.source_address)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, request):
        return self.do_open(_PinnedHTTPConnection, request)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(_PinnedHTTPSConnection, request)


class _PublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        old = urllib.parse.urlsplit(request.full_url)
        new = urllib.parse.urlsplit(new_url)
        if ((old.scheme == 'https' and new.scheme != 'https') or not public_http_url(new_url)):
            raise urllib.error.HTTPError(new_url, code, 'Redirect target is not public', headers, response)
        return super().redirect_request(request, response, code, message, headers, new_url)


def safe_urlopen(request, timeout=30):
    """Fetch public HTTP(S) resources with DNS-pinned connections and safe redirects."""
    url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
    if not public_http_url(url):
        raise ValueError('URL must resolve to a public HTTP(S) address')
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _PublicRedirectHandler(),
        _PinnedHTTPHandler(), _PinnedHTTPSHandler())
    return opener.open(request, timeout=timeout)
