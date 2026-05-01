"""
Unit tests for batocera/kente_security.py.

Run from repo root:
    python -m unittest tests.test_kente_security

Stdlib-only — matches the "pip-free" constraint of the batocera/ tree.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'batocera'))
from kente_security import origin_allowed, safe_resolve


class OriginAllowedTests(unittest.TestCase):
    def test_missing_origin_allowed(self):
        # curl, Electron preload, server-to-server requests have no Origin.
        self.assertTrue(origin_allowed(''))
        self.assertTrue(origin_allowed(None))

    def test_localhost_variants_allowed(self):
        for o in (
            'http://localhost:7777',
            'http://127.0.0.1:7777',
            'http://[::1]:7777',
            'https://localhost',
        ):
            with self.subTest(origin=o):
                self.assertTrue(origin_allowed(o))

    def test_external_origins_rejected(self):
        for o in (
            'http://evil.com',
            'https://kente.example.org',
            'http://192.168.1.50:7777',
            'http://localhost.evil.com',
        ):
            with self.subTest(origin=o):
                self.assertFalse(origin_allowed(o))

    def test_garbage_origin_rejected(self):
        # Malformed Origin should not be treated as missing.
        self.assertFalse(origin_allowed('not a url'))
        self.assertFalse(origin_allowed('javascript:alert(1)'))


class SafeResolveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        # Create a real file inside the base so resolution can succeed.
        (self.base / 'index.html').write_text('<!doctype html>')
        (self.base / 'sub').mkdir()
        (self.base / 'sub' / 'a.js').write_text('// js')

    def tearDown(self):
        self.tmp.cleanup()

    def test_root_resolves(self):
        p = safe_resolve(self.base, '/index.html')
        self.assertIsNotNone(p)
        self.assertTrue(str(p).startswith(str(self.base.resolve())))

    def test_subdirectory_resolves(self):
        p = safe_resolve(self.base, '/sub/a.js')
        self.assertIsNotNone(p)
        self.assertEqual(p.name, 'a.js')

    def test_dotdot_traversal_rejected(self):
        # Any path that escapes base must be rejected even though the parent
        # directory exists (it's outside the sandbox).
        self.assertIsNone(safe_resolve(self.base, '/../etc/passwd'))
        self.assertIsNone(safe_resolve(self.base, '/sub/../../escape'))

    def test_url_decoded_path(self):
        # %20 must decode to a space so files with spaces resolve correctly.
        spaced = self.base / 'has space.txt'
        spaced.write_text('x')
        p = safe_resolve(self.base, '/has%20space.txt')
        self.assertIsNotNone(p)
        self.assertEqual(p.name, 'has space.txt')

    def test_sibling_prefix_not_accepted(self):
        # A directory whose name starts with the base's name must not be
        # accepted.  Create a sibling and try to reach it via a crafted path.
        sibling = self.base.parent / (self.base.name + '_evil')
        sibling.mkdir(exist_ok=True)
        try:
            (sibling / 'leak.txt').write_text('x')
            # Walk up one then back into the sibling — should be rejected.
            attack = f'/../{sibling.name}/leak.txt'
            self.assertIsNone(safe_resolve(self.base, attack))
        finally:
            try:
                (sibling / 'leak.txt').unlink()
                sibling.rmdir()
            except OSError:
                pass

    def test_empty_path_resolves_to_base(self):
        # Some callers pass '' for the root request before mapping to
        # /index.html.  safe_resolve should treat it as the base itself,
        # which is inside the base, so it must be accepted.
        p = safe_resolve(self.base, '')
        self.assertIsNotNone(p)
        self.assertEqual(p, self.base.resolve())


if __name__ == '__main__':
    unittest.main()
