"""Host an owned Windows game window inside the Electron player surface."""
import ctypes
from ctypes import wintypes
import math
import os
import platform
import subprocess
import threading
import time


def player_rect(value):
    """Keep browser coordinates bounded before passing them to Win32."""
    if not isinstance(value, dict):
        raise ValueError('Missing player bounds')
    result = {}
    for key in ('x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'):
        number = value.get(key)
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            raise ValueError('Invalid player bounds')
        if number < 0 or number > 65536 or (key not in ('x', 'y') and number < 1):
            raise ValueError('Invalid player bounds')
        result[key] = float(number)
    if (result['x'] + result['width'] > result['viewportWidth'] + 2
            or result['y'] + result['height'] > result['viewportHeight'] + 2):
        raise ValueError('Player bounds extend outside the app')
    return result


def choose_window(windows, engine=''):
    """Ignore graphics-driver helper windows and prefer the actual game surface."""
    candidates = []
    for window in windows:
        cls, title = window['class'].lower(), window['title'].strip()
        if (window['width'] < 100 or window['height'] < 80
                or any(word in cls for word in ('observer', 'nvopengl', 'pbuffer', 'tooltips', 'ime'))):
            continue
        if engine == 'pcsx2' and (not title or title.lower().startswith('pcsx2 v')):
            continue
        score = (20 if window['visible'] else 0) + (10 if title else 0)
        if title.lower().startswith(('dolphin ', 'rpcs3 ')):
            score -= 15
        candidates.append((score, window['width'] * window['height'], window))
    return max(candidates, key=lambda item: item[:2])[2] if candidates else None


class Windows:
    def __init__(self):
        if platform.system() != 'Windows':
            raise RuntimeError('In-app native games require the Windows desktop app')
        self.api = ctypes.WinDLL('user32', use_last_error=True)
        self.enum_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        specs = {
            'EnumWindows': ([self.enum_callback, wintypes.LPARAM], wintypes.BOOL),
            'IsWindow': ([wintypes.HWND], wintypes.BOOL),
            'IsWindowVisible': ([wintypes.HWND], wintypes.BOOL),
            'GetWindowThreadProcessId': ([wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            'GetWindowTextW': ([wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            'GetClassNameW': ([wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            'GetWindowRect': ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
            'GetClientRect': ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
            'GetWindowLongPtrW': ([wintypes.HWND, ctypes.c_int], ctypes.c_ssize_t),
            'SetWindowLongPtrW': ([wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t], ctypes.c_ssize_t),
            'SetParent': ([wintypes.HWND, wintypes.HWND], wintypes.HWND),
            'GetParent': ([wintypes.HWND], wintypes.HWND),
            'SetWindowPos': ([wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT], wintypes.BOOL),
            'ShowWindow': ([wintypes.HWND, ctypes.c_int], wintypes.BOOL),
            'SetFocus': ([wintypes.HWND], wintypes.HWND),
            'SetForegroundWindow': ([wintypes.HWND], wintypes.BOOL),
            'GetForegroundWindow': ([], wintypes.HWND),
            'GetAsyncKeyState': ([ctypes.c_int], ctypes.c_short),
            'PostMessageW': ([wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], wintypes.BOOL),
            'GetWindowDpiAwarenessContext': ([wintypes.HWND], ctypes.c_void_p),
            'SetThreadDpiAwarenessContext': ([ctypes.c_void_p], ctypes.c_void_p),
        }
        for name, (args, result) in specs.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result

    def pid(self, hwnd):
        pid = wintypes.DWORD()
        self.api.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value

    def windows(self, pid):
        result = []
        @self.enum_callback
        def visit(hwnd, _):
            if self.pid(hwnd) == pid:
                title, cls, rect = ctypes.create_unicode_buffer(1024), ctypes.create_unicode_buffer(256), wintypes.RECT()
                self.api.GetWindowTextW(hwnd, title, len(title))
                self.api.GetClassNameW(hwnd, cls, len(cls))
                self.api.GetWindowRect(hwnd, ctypes.byref(rect))
                result.append({'hwnd': int(hwnd), 'title': title.value, 'class': cls.value,
                               'visible': bool(self.api.IsWindowVisible(hwnd)),
                               'width': rect.right - rect.left, 'height': rect.bottom - rect.top})
            return True
        self.api.EnumWindows(visit, 0)
        return result

    def attach(self, hwnd, parent):
        self.api.SetThreadDpiAwarenessContext(self.api.GetWindowDpiAwarenessContext(parent))
        style = self.api.GetWindowLongPtrW(hwnd, -16)
        self.api.SetWindowLongPtrW(hwnd, -16, (style & ~0x80CF0000) | 0x40000000)
        self.api.SetParent(hwnd, parent)
        if self.api.GetParent(hwnd) != parent:
            raise RuntimeError('The game window could not be attached to Kente')

    def resize(self, hwnd, parent, rect):
        previous = self.api.SetThreadDpiAwarenessContext(self.api.GetWindowDpiAwarenessContext(parent))
        try:
            client = wintypes.RECT()
            if not self.api.GetClientRect(parent, ctypes.byref(client)):
                return
            sx, sy = client.right / rect['viewportWidth'], client.bottom / rect['viewportHeight']
            self.api.SetWindowPos(hwnd, 0, round(rect['x'] * sx), round(rect['y'] * sy),
                                  max(1, round(rect['width'] * sx)), max(1, round(rect['height'] * sy)), 0x0024)
        finally:
            self.api.SetThreadDpiAwarenessContext(previous)

    def key(self, hwnd, key):
        self.api.PostMessageW(hwnd, 0x0100, key, 1)
        self.api.PostMessageW(hwnd, 0x0101, key, 0xC0000001)

    def key_state(self, hwnd, key, down):
        self.api.PostMessageW(hwnd, 0x0100 if down else 0x0101, key, 1 if down else 0xC0000001)


class NativeSession:
    def __init__(self, config, engine='', windows=None):
        self.windows = windows or Windows()
        try:
            self.parent = int(config['hwnd'])
        except (ValueError, TypeError, KeyError):
            raise ValueError('Invalid app window')
        expected = int(os.environ.get('KENTE_HOST_PID', '0'))
        if not expected or not self.windows.api.IsWindow(self.parent) or self.windows.pid(self.parent) != expected:
            raise ValueError('Native player must belong to the running Kente app')
        self.rect = player_rect(config.get('rect'))
        self.engine = engine
        self.session_id = str(config.get('sessionId') or '')[:128]
        self.proc = None
        self.hwnd = None
        self.cancelled = threading.Event()
        self.hidden = False
        self.error = None
        self.menu_requested = False
        self.fullscreen_requested = False
        self.paused = False
        self._keys = {}
        self.remote_pad_config = None
        self.remote_pad_backup = None

    def attach(self, proc, timeout=25):
        self.proc = proc
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.cancelled.is_set():
                self.stop()
                raise RuntimeError('Game launch cancelled')
            if proc.poll() is not None:
                raise RuntimeError('The game engine exited before opening its player window')
            candidate = choose_window(self.windows.windows(proc.pid), self.engine)
            if candidate:
                self.hwnd = candidate['hwnd']
                self.windows.attach(self.hwnd, self.parent)
                self.windows.resize(self.hwnd, self.parent, self.rect)
                self.windows.api.ShowWindow(self.hwnd, 0 if self.hidden else 5)
                threading.Thread(target=self._watch, daemon=True).start()
                return
            time.sleep(.05)
        self.stop()
        raise RuntimeError('The game engine did not open an in-app player window')

    def _watch(self):
        try:
            while self.proc.poll() is None and not self.cancelled.is_set():
                if not self.windows.api.IsWindow(self.parent):
                    self.stop()
                    break
                if not self.windows.api.IsWindow(self.hwnd):
                    candidate = choose_window(self.windows.windows(self.proc.pid), self.engine)
                    if candidate:
                        self.hwnd = candidate['hwnd']
                        self.windows.attach(self.hwnd, self.parent)
                if self.windows.api.IsWindow(self.hwnd):
                    self.windows.resize(self.hwnd, self.parent, self.rect)
                foreground = self.windows.api.GetForegroundWindow()
                if self.windows.pid(foreground) in (self.proc.pid, self.windows.pid(self.parent)):
                    for key, action in ((0x1B, 'menu_requested'), (0x7A, 'fullscreen_requested')):
                        pressed = bool(self.windows.api.GetAsyncKeyState(key) & 0x8000)
                        if pressed and not self._keys.get(key):
                            setattr(self, action, True)
                        self._keys[key] = pressed
                time.sleep(.1)
        except Exception as error:
            self.error = str(error)

    def update_rect(self, rect):
        self.rect = player_rect(rect)
        if self.hwnd and self.windows.api.IsWindow(self.hwnd):
            self.windows.resize(self.hwnd, self.parent, self.rect)

    def menu(self, opened):
        self.hidden = bool(opened)
        if not self.hwnd:
            return
        # This binding is configured in Kente's private PCSX2 profile.
        if self.engine == 'pcsx2' and self.paused != self.hidden:
            self.windows.key(self.hwnd, 0x7B)
            self.paused = self.hidden
        self.windows.api.ShowWindow(self.hwnd, 0 if self.hidden else 5)
        if not self.hidden:
            self.windows.api.SetFocus(self.hwnd)

    def remote_key(self, key, down):
        """Apply an allowlisted Player 2 keyboard binding to the live PCSX2 window."""
        if self.engine != 'pcsx2' or not self.hwnd or not self.windows.api.IsWindow(self.hwnd):
            raise RuntimeError('Remote controls are available only during a PS2 session')
        virtual_keys = {
            'w': 0x57, 'a': 0x41, 's': 0x53, 'd': 0x44,
            'i': 0x49, 'j': 0x4A, 'k': 0x4B, 'l': 0x4C,
            'u': 0x55, 'o': 0x4F, 'q': 0x51, 'e': 0x45, 'z': 0x5A, 'c': 0x43,
        }
        vk = virtual_keys.get(str(key).lower())
        if vk is None:
            raise ValueError('Unknown remote controller input')
        self.windows.key_state(self.hwnd, vk, bool(down))

    def status(self):
        running = bool(self.proc and self.proc.poll() is None)
        result = {'running': running, 'embedded': bool(running and self.hwnd), 'pid': self.proc.pid if running else None,
                  'engine': self.engine, 'window': self.hwnd, 'parent': self.parent,
                  'hidden': self.hidden,
                  'sessionId': self.session_id, 'menuRequested': self.menu_requested,
                  'fullscreenRequested': self.fullscreen_requested, 'error': self.error}
        self.menu_requested = self.fullscreen_requested = False
        return result

    def stop(self):
        self.cancelled.set()
        if self.remote_pad_backup is not None:
            try:
                from kente_runtime import restore_remote_pcsx2_player2
                restore_remote_pcsx2_player2(self.remote_pad_config, self.remote_pad_backup)
            except Exception as error:
                self.error = self.error or f'Could not restore PCSX2 Player 2 controls: {error}'
            self.remote_pad_backup = None
        if not self.proc or self.proc.poll() is not None:
            return
        if platform.system() == 'Windows':
            # PCSX2 and some other engines can create helper/GS processes.
            # Terminating only the Popen handle can leave those behind.
            try:
                subprocess.run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'],
                               capture_output=True, timeout=8, check=False,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            except (OSError, subprocess.TimeoutExpired):
                pass
            try:
                self.proc.wait(timeout=2)
                return
            except Exception:
                pass
        if self.hwnd and self.windows.api.IsWindow(self.hwnd):
            self.windows.api.PostMessageW(self.hwnd, 0x0010, 0, 0)
            try:
                self.proc.wait(timeout=3)
                return
            except Exception:
                pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=2)
        except Exception:
            self.proc.kill()
