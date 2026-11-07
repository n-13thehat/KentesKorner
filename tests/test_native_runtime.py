"""Native window bounds and portable runtime isolation regressions."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'batocera'))
import kente_native_host as host
import kente_runtime as runtime


class NativeHostTests(unittest.TestCase):
    def test_player_rect_rejects_bad_or_outside_bounds(self):
        good = dict(x=0, y=0, width=640, height=480, viewportWidth=1280, viewportHeight=720)
        self.assertEqual(host.player_rect(good)['width'], 640)
        for invalid in (None, [], {**good, 'x': -1}, {**good, 'width': float('inf')},
                        {**good, 'x': 700, 'width': 640}, {**good, 'viewportHeight': True}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                host.player_rect(invalid)

    def test_game_surface_selection_skips_helpers_and_pcsx2_control_window(self):
        windows = [
            {'hwnd': 1, 'class': 'NVOpenGLWindow', 'title': 'OpenGL', 'width': 1920, 'height': 1080, 'visible': True},
            {'hwnd': 2, 'class': 'QWindow', 'title': 'PCSX2 v2.4.0', 'width': 1920, 'height': 1080, 'visible': True},
            {'hwnd': 3, 'class': 'QWindowIcon', 'title': 'Tekken 3', 'width': 1920, 'height': 1080, 'visible': False},
        ]
        self.assertEqual(host.choose_window(windows, 'pcsx2')['hwnd'], 3)
        self.assertIsNone(host.choose_window(windows[:2], 'pcsx2'))


class RuntimeIsolationTests(unittest.TestCase):
    def test_distribution_copy_excludes_user_roms_bios_and_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source', Path(tmp) / 'target'
            (source / 'resources').mkdir(parents=True)
            (source / 'config').mkdir()
            (source / 'pcsx2-qt.exe').write_bytes(b'exe')
            (source / 'Qt6Core.dll').write_bytes(b'dll')
            (source / 'resources' / 'styles.qss').write_text('style')
            (source / 'config' / 'PCSX2.ini').write_text('personal')
            (source / 'bios').mkdir()
            (source / 'bios' / 'scph.bin').write_bytes(b'bios')
            (source / 'roms').mkdir()
            (source / 'roms' / 'game.iso').write_bytes(b'game')
            runtime.copy_distribution(source, target)
            self.assertEqual((target / 'pcsx2-qt.exe').read_bytes(), b'exe')
            self.assertTrue((target / 'resources' / 'styles.qss').exists())
            self.assertFalse((target / 'config').exists())
            self.assertFalse((target / 'bios').exists())
            self.assertFalse((target / 'roms').exists())

    def test_unknown_engines_and_nonportable_imports_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                runtime.import_runtime('bad-engine', tmp)
            with self.assertRaises(ValueError):
                runtime.import_runtime('pcsx2', tmp)


if __name__ == '__main__':
    unittest.main()
