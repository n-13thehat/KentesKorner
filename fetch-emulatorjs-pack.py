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
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
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

FLYCAST_RELEASE = "https://github.com/nasomers/flycast-wasm/releases/download/v1.0"
COMMUNITY_CORE_ASSETS = {
    "flycast_libretro.js": (
        f"{FLYCAST_RELEASE}/flycast_libretro.js",
        "1f2ae9afafa85c8ff577ca3961be0343c2ac394ddc79285981f0d55ad75dbd7b",
    ),
    "flycast_libretro.wasm": (
        f"{FLYCAST_RELEASE}/flycast_libretro.wasm",
        "db2b87d8d2742087a56c4eeed317da14e3549ee037e36de3d77c1e6e5291bead",
    ),
}
FLYCAST_CORE_METADATA = {
    "name": "flycast",
    "extensions": ["cdi", "gdi", "chd", "cue", "iso", "elf", "bin", "lst", "zip", "7z", "dat"],
    "options": {},
    "save": "state",
    "license": "GPLv2",
    "repo": "https://github.com/flyinghead/flycast",
}


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


def _download_community_core(dest: Path) -> bool:
    """Build the EmulatorJS .data ZIP from Flycast's pinned JS/WASM release."""
    assets: dict[str, bytes] = {}
    for name, (url, expected_sha256) in COMMUNITY_CORE_ASSETS.items():
        request = urllib.request.Request(url, headers={"User-Agent": "KenteKorner/1.0"})
        with urllib.request.urlopen(request, timeout=600) as response:
            payload = response.read()
        actual_sha256 = hashlib.sha256(payload).hexdigest()
        if actual_sha256 != expected_sha256:
            raise ValueError(f"{name} checksum mismatch: expected {expected_sha256}, got {actual_sha256}")
        assets[name] = payload

    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name(dest.name + ".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name, payload in assets.items():
            bundle.writestr(name, payload)
        bundle.writestr("core.json", json.dumps(FLYCAST_CORE_METADATA, separators=(",", ":")))
    temporary.replace(dest)
    return True


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="stable", help="CDN version: stable|latest|nightly|<tag>")
    ap.add_argument("--base", default=None, help="Override CDN base URL (must end with /data/)")
    ap.add_argument("--dest", default=str(Path("cache") / "ejs-stable"), help="Output directory")
    ap.add_argument("--strict", action="store_true",
                    help="Fail unless the required runtime files and at least one archive per core are present")
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
        todo.append(f"cores/reports/{c}.json")

    # Dreamcast is not hosted by the EmulatorJS CDN; stage its community core
    # separately so packaged desktop builds do not need a first-launch download.
    community_dest = dest_root.parent / "ejs-cores"
    community_failures: list[str] = []
    community_name = "flycast-wasm.data"
    community_target = community_dest / community_name
    if not community_target.is_file() or community_target.stat().st_size == 0:
        try:
            _download_community_core(community_target)
            print(f"[ejs-pack] OK   {community_name} (assembled from pinned upstream JS/WASM assets)")
        except Exception as e:
            community_failures.append(community_name)
            print(f"[ejs-pack] FAIL {community_name}: {e}")

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
        if dest.is_file() and dest.stat().st_size > 0:
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

    if args.strict:
        missing = [rel for rel in REQUIRED_FILES
                   if not (dest_root / rel).is_file() or (dest_root / rel).stat().st_size == 0]
        for core in REQUIRED_CORES:
            variants = [dest_root / "cores" / f"{core}{suffix}" for suffix in (
                "-wasm.data", "-legacy-wasm.data", "-thread-wasm.data", "-thread-legacy-wasm.data")]
            if not any(path.is_file() and path.stat().st_size > 0 for path in variants):
                missing.append(f"cores/{core} (no usable archive variant)")
            report = dest_root / "cores" / "reports" / f"{core}.json"
            if not report.is_file() or report.stat().st_size == 0:
                missing.append(f"cores/reports/{core}.json")
        ppsspp_assets = dest_root / "cores" / "ppsspp-assets.zip"
        if not ppsspp_assets.is_file() or ppsspp_assets.stat().st_size == 0:
            missing.append("cores/ppsspp-assets.zip")
        missing.extend(f"cache/ejs-cores/{name}" for name in community_failures)
        if not community_target.is_file() or community_target.stat().st_size == 0:
            missing.append(f"cache/ejs-cores/{community_name}")
        missing = list(dict.fromkeys(missing))
        if missing:
            print("[ejs-pack] ERROR: installer runtime is incomplete:")
            for rel in missing:
                print(f"  - {rel}")
            return 1

    dur = time.time() - start
    print(f"[ejs-pack] Done in {dur:.1f}s. downloaded={ok}, skipped_404={skipped_404}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

