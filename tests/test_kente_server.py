"""Local HTTP regressions; no providers, emulators, or internet required."""
import http.client
import gzip
import base64
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'batocera'))
# Keep configuration initialization in a disposable data directory on every OS.
with tempfile.TemporaryDirectory() as data_dir, mock.patch.dict(os.environ, {
    'KENTE_APP_MODE': 'electron', 'KENTE_DATA_DIR': data_dir, 'KENTE_WEB_DIR': str(ROOT),
}):
    spec = importlib.util.spec_from_file_location('kente_server', ROOT / 'batocera' / 'kente-server.py')
    server_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server_module)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), server_module.KenteHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, resp.read(), dict(resp.getheaders())
        finally:
            conn.close()

    def test_ping_and_frontend_assets(self):
        status, body, _ = self.request('GET', '/api/ping')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['version'], server_module.__version__)
        for path in ('/', '/js/storage.js', '/vendor/hls.light.min.js',
                     '/Conceptual%20Artifacts/KenteCorner%20Logo.png'):
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 200)

    def test_electron_bios_import_is_stored_under_a_fixed_filename(self):
        payload = b'Kente test BIOS bytes'
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(server_module, 'BIOS_DIR', Path(temp)):
            status, body, _ = self.request('POST', '/api/bios/import', json.dumps({
                'systemId': 'ps1', 'data': base64.b64encode(payload).decode('ascii'),
            }))
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['filename'], 'scph1001.bin')
            self.assertEqual((Path(temp) / 'scph1001.bin').read_bytes(), payload)
            status, body, headers = self.request('GET', '/api/bios/file?systemId=ps1')
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-Kente-Filename'], 'scph1001.bin')
            self.assertEqual(body, payload)
            self.assertEqual(self.request('GET', '/api/bios/file?systemId=../../outside')[0], 404)

    def test_native_start_honors_cancel_requested_before_launch(self):
        session_id = 'cancel-before-native-start-test'
        self.request('POST', '/api/native/control', json.dumps({'action': 'stop', 'sessionId': session_id}))
        status, body, _ = self.request('POST', '/api/native/start', json.dumps({
            'systemId': 'ps2', 'title': 'Cancelled test', 'host': {'sessionId': session_id},
        }))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['error'], 'CANCELLED')

    def test_private_files_are_not_static_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            web = Path(temp)
            for name in ('.git/config', 'artkeys.json', 'batocera/kente-server.py',
                         'roms/nes/private.nes', 'js/.secret', 'package.json'):
                target = web / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('private')
            with mock.patch.object(server_module, 'WEB_DIR', web):
                for path in ('/.git/config', '/%2egit/config', '/artkeys.json',
                             '/batocera/kente-server.py', '/roms/nes/private.nes',
                             '/js/.secret', '/package.json'):
                    with self.subTest(path=path):
                        self.assertEqual(self.request('GET', path)[0], 403)

    def test_invalid_content_lengths_return_bad_request(self):
        for length in ('-1', 'invalid'):
            with self.subTest(length=length):
                status, body, _ = self.request('POST', '/api/settings', headers={'Content-Length': length})
                self.assertEqual(status, 400)
                self.assertIn('error', json.loads(body))

    def test_non_object_json_is_rejected(self):
        for body in ('[]', 'null', 'true', '"text"', '5'):
            with self.subTest(body=body):
                status, response, _ = self.request('POST', '/api/launch-rom', body)
                self.assertEqual(status, 400)
                self.assertIn('error', json.loads(response))

    def test_invalid_json_is_rejected(self):
        self.assertEqual(self.request('POST', '/api/settings', '{')[0], 400)

    def test_external_websites_cannot_read_or_trigger_local_api_routes(self):
        for headers in ({'Origin': 'https://unrelated.example'}, {'Origin': 'null'},
                        {'Sec-Fetch-Site': 'cross-site'}):
            with self.subTest(headers=headers):
                for path in ('/api/system/info', '/api/kill', '/api/open-folder?path=test',
                             '/api/flash/cache-clear', '/api/theater/proxy?url=https://example.org'):
                    self.assertEqual(self.request('GET', path, headers=headers)[0], 403)
                self.assertEqual(self.request('POST', '/api/settings', '{}', headers)[0], 403)
                self.assertEqual(self.request('GET', '/api/ping', headers=headers)[0], 200)

    def test_local_browser_origins_can_use_the_api(self):
        for origin in ('http://localhost:7777', 'http://127.0.0.1:7777'):
            with self.subTest(origin=origin):
                self.assertEqual(self.request('GET', '/api/app/status', headers={
                    'Origin': origin, 'Sec-Fetch-Site': 'cross-site',
                })[0], 200)

    def test_launch_rom_rejects_paths_outside_the_system_folder(self):
        with mock.patch.object(server_module, 'find_and_launch_rom') as launch:
            for system_id, filename in (('../escape', 'game.iso'), ('nes', '../game.nes'),
                                        ('nes', 'C:\\outside.nes'), ('nes', '')):
                with self.subTest(system_id=system_id, filename=filename):
                    status, _, _ = self.request('POST', '/api/launch-rom', json.dumps({
                        'systemId': system_id, 'filename': filename,
                    }))
                    self.assertEqual(status, 400)
            launch.assert_not_called()

    def test_hls_attributes_and_segments_stay_on_the_proxy(self):
        handler = object.__new__(server_module.KenteHandler)
        base = 'https://media.example/path/master.m3u8'
        playlist = ('#EXTM3U\n'
                    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key%2Fone.bin?sig=a%2Bb"\n'
                    '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subtitles/en.m3u8"\n'
                    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="512@0"\n'
                    '#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild/stream.m3u8\n')
        rewritten = handler._rewrite_hls(playlist, base)
        for uri in ('keys/key%2Fone.bin?sig=a%2Bb', 'subtitles/en.m3u8', 'init.mp4', 'child/stream.m3u8'):
            with self.subTest(uri=uri):
                expected = '/api/theater/proxy?url=' + urllib.parse.quote(urllib.parse.urljoin(base, uri), safe='')
                self.assertIn(expected, rewritten)
        self.assertIn('BYTERANGE="512@0"', rewritten)

    def test_proxy_preserves_percent_encoding_in_signed_urls(self):
        target = 'https://media.example/file%2Fname.ts?token=a%2Bb%26c'
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Type': 'video/mp2t'}
        upstream.status = 200
        upstream.geturl.return_value = target
        upstream.read.side_effect = [b'video', b'']
        with mock.patch.object(server_module, '_public_http_url', return_value=True), \
                mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = upstream
            status, body, _ = self.request('GET', '/api/theater/proxy?url=' + urllib.parse.quote(target, safe=''))
            self.assertEqual(status, 200)
            self.assertEqual(body, b'video')
            self.assertEqual(urlopen.call_args.args[0].full_url, target)

    def test_proxy_uses_the_redirected_playlist_url_for_relative_links(self):
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Type': 'application/vnd.apple.mpegurl'}
        upstream.status = 200
        upstream.geturl.return_value = 'https://cdn.example/new/path/master.m3u8'
        upstream.read.side_effect = [b'#EXTM3U\nsegment.ts\n', b'']
        with mock.patch.object(server_module, '_public_http_url', return_value=True), \
                mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = upstream
            status, body, _ = self.request('GET', '/api/theater/proxy?url=https%3A%2F%2Forigin.example%2Fmaster.m3u8')
            self.assertEqual(status, 200)
            self.assertIn(urllib.parse.quote('https://cdn.example/new/path/segment.ts', safe=''), body.decode())

    def test_proxy_rewrites_a_compressed_playlist_with_a_byte_order_mark(self):
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Encoding': 'gzip'}
        upstream.status = 200
        upstream.geturl.return_value = 'https://cdn.example/path/master.m3u8'
        upstream.read.side_effect = [gzip.compress(b'\xef\xbb\xbf#EXTM3U\nsegment.ts\n'), b'']
        with mock.patch.object(server_module, '_public_http_url', return_value=True), \
                mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = upstream
            status, body, headers = self.request('GET', '/api/theater/proxy?url=https%3A%2F%2Forigin.example%2Fmaster.m3u8')
            self.assertEqual(status, 200)
            self.assertTrue(body.startswith(b'#EXTM3U'))
            self.assertIn(urllib.parse.quote('https://cdn.example/path/segment.ts', safe=''), body.decode())
            self.assertNotIn('Content-Encoding', headers)
            self.assertEqual(int(headers['Content-Length']), len(body))

    def test_video_proxy_starts_responding_before_the_upstream_finishes(self):
        release = threading.Event()
        started = threading.Event()
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Type': 'video/mp4', 'Content-Length': '9',
                            'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 0-8/100'}
        upstream.status = 206
        upstream.geturl.return_value = 'https://media.example/video.mp4'

        def read(size=-1):
            if not started.is_set():
                started.set()
                if size < 0:
                    release.wait(3)
                    return b'complete!'
                return b'complete'
            release.wait(3)
            return b'!' if upstream.read.call_count == 2 else b''

        upstream.read.side_effect = read
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=1)
        try:
            with mock.patch.object(server_module, '_public_http_url', return_value=True), \
                    mock.patch.object(server_module, '_safe_urlopen') as urlopen:
                urlopen.return_value.__enter__.return_value = upstream
                conn.request('GET', '/api/theater/proxy?url=https%3A%2F%2Fmedia.example%2Fvideo.mp4',
                             headers={'Range': 'bytes=0-8'})
                try:
                    resp = conn.getresponse()
                finally:
                    release.set()
                self.assertEqual(resp.status, 206)
                self.assertEqual(resp.getheader('Content-Range'), 'bytes 0-8/100')
                self.assertEqual(resp.read(), b'complete!')
                self.assertEqual(urlopen.call_args.args[0].get_header('Range'), 'bytes=0-8')
        finally:
            release.set()
            conn.close()

    def test_theater_proxy_rejects_non_http_urls(self):
        with mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            for target in ('file:///etc/passwd', 'ftp://example.org/video', 'not-a-url'):
                with self.subTest(target=target):
                    status, _, _ = self.request('GET', '/api/theater/proxy?url=' + urllib.parse.quote(target, safe=''))
                    self.assertEqual(status, 400)
            urlopen.assert_not_called()

    def test_rom_proxy_releases_its_download_reservation_after_upstream_failure(self):
        params = urllib.parse.urlencode({
            'url': 'https://archive.org/download/test/game.nes',
            'save': '1', 'systemId': 'nes', 'filename': 'game.nes',
        })
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(server_module, 'ROMS_DIR', Path(temp)), \
                mock.patch.object(server_module, '_safe_urlopen',
                                  side_effect=urllib.error.HTTPError('https://archive.org', 503, 'Unavailable', {}, None)):
            target = str(Path(temp) / 'nes' / 'game.nes')
            try:
                status, body, _ = self.request('GET', '/api/rom-proxy?' + params)
                self.assertEqual(status, 502)
                self.assertEqual(json.loads(body)['upstreamStatus'], 503)
                self.assertNotIn(target, server_module._active_downloads)
            finally:
                server_module._active_downloads.discard(target)

    def test_rom_proxy_never_promotes_a_truncated_download(self):
        params = urllib.parse.urlencode({
            'url': 'https://archive.org/download/test/game.nes',
            'save': '1', 'systemId': 'nes', 'filename': 'game.nes',
        })
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': '100'}
        upstream.read.side_effect = [b'partial', b'']
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(server_module, 'ROMS_DIR', Path(temp)), \
                mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = upstream
            with self.assertRaises(http.client.IncompleteRead):
                self.request('GET', '/api/rom-proxy?' + params)
            self.assertEqual(list((Path(temp) / 'nes').iterdir()), [])

    def test_rom_proxy_saves_the_complete_transfer(self):
        params = urllib.parse.urlencode({
            'url': 'https://archive.org/download/test/game.nes',
            'save': '1', 'systemId': 'nes', 'filename': 'game.nes',
        })
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': '9'}
        upstream.read.side_effect = [b'complete', b'!', b'']
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(server_module, 'ROMS_DIR', Path(temp)), \
                mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = upstream
            status, body, headers = self.request('GET', '/api/rom-proxy?' + params)
            self.assertEqual(status, 200)
            self.assertEqual(body, b'complete!')
            target = Path(temp) / 'nes' / 'game.nes'
            self.assertEqual(target.read_bytes(), body)
            self.assertEqual(headers['X-Kente-Saved-Path'], str(target))
            self.assertNotIn(str(target), server_module._active_downloads)

    def test_background_download_preserves_existing_rom_when_upstream_is_truncated(self):
        upstream = mock.MagicMock()
        upstream.headers = {'Content-Length': '100'}
        upstream.read.side_effect = [b'partial', b'']
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(server_module, 'ROMS_DIR', Path(temp)), \
                mock.patch.object(server_module, '_safe_urlopen') as urlopen:
            target = Path(temp) / 'nes' / 'game.nes'
            target.parent.mkdir()
            target.write_bytes(b'existing')
            urlopen.return_value.__enter__.return_value = upstream
            success, error, size = server_module.download_rom('nes', 'game.nes', 'https://archive.org/download/test/game.nes')
            self.assertFalse(success)
            self.assertIn('Incomplete', error)
            self.assertEqual(size, 0)
            self.assertEqual(target.read_bytes(), b'existing')
            self.assertEqual(list(target.parent.iterdir()), [target])
            self.assertNotIn(str(target), server_module._active_downloads)

    def test_saved_rom_can_be_resolved_and_loaded_through_http(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(server_module, 'ROMS_DIR', Path(temp)):
            target = Path(temp) / 'psx' / 'Tony Hawk S Pro Skater 2.bin'
            target.parent.mkdir()
            content = b'raw-disc-data' * 512
            target.write_bytes(content)
            params = urllib.parse.urlencode({'systemId': 'ps1', 'title': "Tony Hawk's Pro Skater 2"})
            status, body, _ = self.request('GET', '/api/rom/resolve?' + params)
            self.assertEqual(status, 200)
            result = json.loads(body)
            self.assertTrue(result['found'])
            self.assertEqual(result['filename'], target.name)
            status, streamed, _ = self.request('GET', result['url'])
            self.assertEqual(status, 200)
            self.assertEqual(streamed, content)

    def test_saved_rom_lookup_rejects_other_sequels_and_placeholder_files(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(server_module, 'ROMS_DIR', Path(temp)):
            folder = Path(temp) / 'psx'
            folder.mkdir()
            (folder / 'Tony Hawk S Pro Skater 4.7z').write_bytes(b'archive' * 1024)
            (folder / 'Tony Hawk S Pro Skater 2.bin').write_bytes(b'KENTE_STUB_ROM_DO_NOT_LAUNCH')
            self.assertIsNone(server_module.find_rom('ps1', "Tony Hawk's Pro Skater 2"))

    def test_saved_ps2_lookup_uses_the_requested_sequel(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(server_module, 'ROMS_DIR', Path(temp)):
            folder = Path(temp) / 'ps2'
            folder.mkdir()
            for sequel in (2, 3):
                (folder / f'God of War {sequel}.iso').write_bytes(b'disc' * 1024)
            self.assertEqual(Path(server_module.find_rom('ps2', 'God of War II')).name, 'God of War 2.iso')

    def test_rom_file_route_rejects_path_traversal_and_unrelated_folders(self):
        for filename, folder in (('../private.bin', 'psx'), ('C:\\private.bin', 'psx'),
                                 ('game.bin', 'bios'), ('game.bin', '../psx')):
            params = urllib.parse.urlencode({'systemId': 'ps1', 'filename': filename, 'folder': folder})
            self.assertEqual(self.request('GET', '/api/rom/file?' + params)[0], 400)

    def test_ps2_archive_handoff_returns_the_extracted_iso(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(server_module, 'ROMS_DIR', Path(temp)):
            archive = Path(temp) / 'God of War II.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('game/readme.txt', 'instructions')
                bundle.writestr('game/God of War II.iso', b'disc' * 1024)
            extracted = server_module._extract_rom_container('ps2', archive)
            self.assertEqual(extracted.name, 'God of War II.iso')
            self.assertEqual(extracted.read_bytes(), b'disc' * 1024)

    def test_ps2_rar_containers_follow_the_same_extraction_path(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(server_module, 'ROMS_DIR', Path(temp)):
            archive = Path(temp) / 'God of War II.rar'
            archive.write_bytes(b'rar fixture')

            def extract(args, **_kwargs):
                dest = Path(args[args.index('-C') + 1])
                (dest / 'God of War II.iso').write_bytes(b'disc' * 1024)
                return mock.Mock(returncode=0, stdout='', stderr='')

            with mock.patch.object(server_module.shutil, 'which', return_value='tar'), \
                    mock.patch.object(server_module.subprocess, 'run', side_effect=extract):
                extracted = server_module._extract_rom_container('ps2', archive)
            self.assertEqual(extracted.name, 'God of War II.iso')

    def test_replacement_source_saves_while_an_old_transfer_is_unwinding(self):
        release = threading.Event()
        first = mock.MagicMock()
        first.headers = {'Content-Length': '100'}
        first.__enter__.return_value = first

        def read_first(_size):
            if first.read.call_count == 1:
                return b'partial'
            release.wait(3)
            return b''

        first.read.side_effect = read_first
        second = mock.MagicMock()
        second.headers = {'Content-Length': '8'}
        second.__enter__.return_value = second
        second.read.side_effect = [b'complete', b'']
        params = urllib.parse.urlencode({
            'url': 'https://archive.org/download/test/game.nes',
            'save': '1', 'systemId': 'nes', 'filename': 'game.nes',
        })
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            with tempfile.TemporaryDirectory() as temp, \
                    mock.patch.object(server_module, 'ROMS_DIR', Path(temp)), \
                    mock.patch.object(server_module, '_safe_urlopen', side_effect=[first, second]):
                conn.request('GET', '/api/rom-proxy?' + params)
                old_response = conn.getresponse()
                try:
                    status, body, _ = self.request('GET', '/api/rom-proxy?' + params)
                    self.assertEqual(status, 200)
                    self.assertEqual(body, b'complete')
                    target = Path(temp) / 'nes' / 'game.nes'
                    self.assertEqual(target.read_bytes(), b'complete')
                finally:
                    release.set()
                    with self.assertRaises(http.client.IncompleteRead):
                        old_response.read()
                self.assertEqual(target.read_bytes(), b'complete')
                self.assertEqual(list(target.parent.iterdir()), [target])
        finally:
            release.set()
            conn.close()


if __name__ == '__main__':
    unittest.main()
