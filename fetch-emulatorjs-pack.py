"""
Fetch an EmulatorJS "stable/data" offline pack into ./cache/ejs-stable.

Why:
  - Kente's kente-server.py can serve EmulatorJS assets via /api/ejs/.
  - If ./cache/ejs-stable is bundled into the Electron app (see electron-builder.yml),
    EmulatorJS works fully offline on first launch (no CDN access needed).

This script is intentionally stdlib-only (no pip deps) so it can be run anywhere
Python 3 is available.

Usage:
  python fetch-emulatorjs-pack.py
  python fetch-emulatorjs-pack.py --version stable
  python fetch-emulatorjs-pack.py --dest cache/ejs-stable
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_BASE = "https://cdn.emulatorjs.org/{version}/data/"

# Mirrors batocera/kente-server.py EJS_PREFETCH_FILES + EJS_REQUIRED_CORES.
REQUIRED_FILES = [
    "loader.js",
    "emulator.min.js",
    "emulator.min.css",
    "emulator.css",
    "version.json",
    "src/GameManager.js",
    "src/compression.js",
    "src/emulator.js",
    "src/gamepad.js",
    "src/nipplejs.js",
    "src/shaders.js",
    "src/socket.io.min.js",
    "src/storage.js",
    "compression/extract7z.js",
    "compression/extractzip.js",
    "compression/libunrar.js",
    "compression/libunrar.wasm",
    "localization/en-US.json",
    "localization/retroarch.json",
]

REQUIRED_CORES = [
    "nestopia",
    "gambatte",
    "genesis_plus_gx",
    "stella2014",
    "prosystem",
    "snes9x",
    "mgba",
    "mednafen_pce",
    "fbneo",
    "picodrive",
    "mupen64plus_next",
    "pcsx_rearmed",
    "yabause",
    "desmume2015",
    "melonds",
    "ppsspp",
]


def _download(url: str, dest: Path, timeout: int = 600) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    req = urllib.request.Request(url, headers={"User-Agent": "KenteKorner/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        tmp.write_bytes(data)
        tmp.replace(dest)
        return True
    except urllib.error.HTTPError as e:
        # Some cores don't ship all variants; 404 is expected sometimes.
        if e.code == 404:
            return False
        raise
    finally:
        try:
            tmp.unlink(missing_ok=True)  # py3.8+; ok on py3.11+
        except Exception:
            pass


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="stable", help="CDN version: stable|latest|nightly|<tag>")
    ap.add_argument("--base", default=None, help="Override CDN base URL (must end with /data/)")
    ap.add_argument("--dest", default=str(Path("cache") / "ejs-stable"), help="Output directory")
    args = ap.parse_args(argv)

    base = (args.base or DEFAULT_BASE.format(version=args.version)).strip()
    if not base.endswith("/"):
        base += "/"
    if not base.endswith("/data/") and "/data/" not in base:
        # Allow custom bases that already include /data/, but guard common mistakes.
        print(f"[ejs-pack] Warning: base url does not look like a /data/ folder: {base}")

    dest_root = Path(args.dest).resolve()
    print(f"[ejs-pack] Base: {base}")
    print(f"[ejs-pack] Dest: {dest_root}")

    todo: list[str] = []
    todo.extend(REQUIRED_FILES)
    for c in REQUIRED_CORES:
        for suffix in (
            "-wasm.data",
            "-legacy-wasm.data",
            "-thread-wasm.data",
            "-thread-legacy-wasm.data",
        ):
            todo.append(f"cores/{c}{suffix}")
        if c == "ppsspp":
            todo.append("cores/ppsspp-assets.zip")

    # De-dupe
    seen: set[str] = set()
    todo2: list[str] = []
    for p in todo:
        if p in seen:
            continue
        seen.add(p)
        todo2.append(p)

    ok = 0
    skipped_404 = 0
    start = time.time()

    for i, rel in enumerate(todo2, 1):
        url = base + rel
        dest = dest_root / rel.replace("/", os.sep)
        if dest.exists():
            ok += 1
            continue
        try:
            got = _download(url, dest)
            if got:
                ok += 1
                print(f"[{i:>3}/{len(todo2)}] OK   {rel}")
            else:
                skipped_404 += 1
                print(f"[{i:>3}/{len(todo2)}] 404  {rel} (skipped)")
        except Exception as e:
            print(f"[{i:>3}/{len(todo2)}] FAIL {rel}: {e}")

    dur = time.time() - start
    print(f"[ejs-pack] Done in {dur:.1f}s. downloaded={ok}, skipped_404={skipped_404}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

