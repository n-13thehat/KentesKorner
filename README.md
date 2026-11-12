# Kente's Korner

A retro game room with a searchable game catalog, collections, controller navigation,
browser emulators, in-app native emulator launching, downloads, Flash games, and a video theater.
It runs in a browser, the Electron desktop app, or a Batocera kiosk.

Desktop builds target Windows x64, Intel macOS, and Apple Silicon macOS. The
Windows installer includes Kente's native emulator path. The Mac app includes
an experimental in-app PlayStation 2 player and requires a user-provided PS2
BIOS; GameCube/Wii, PS3, Wii U, Xbox, Xbox 360, and Switch native emulation are
not available on Mac yet. The PCEE2 core is bundled, but Apple Silicon PS2
performance may be very slow. Mac builds also support the web player and
browser based emulators, and PS2 room hosting remains Windows-only. The macOS
DMG is currently unsigned, so Gatekeeper may require the user to approve
opening it. A signed and notarized Mac release, including automatic in-app
updates, requires the publisher's Apple Developer credentials.

To package on the matching operating system, install Node.js 24, Python 3.12,
and PyInstaller, then run `npm ci`. On Windows run `npm run build -- --publish
never`. On macOS run `npm run build:mac -- --publish never`; this produces a DMG
and ZIP under `dist/`. Push a tag matching the app version (for example
`v9.1.9`) to build Windows, Intel Mac, and Apple Silicon Mac installers and
publish a GitHub Release. Windows packaged apps can check and download that release from
Settings; a source commit without a new version tag does not publish an
installable app update.

## Run locally

Use Node.js 24 with npm and Python 3.10 or later. The Python server uses only the standard
library. From this directory:

```powershell
npm ci
npm start
```

Electron starts the Python server at `http://localhost:7777` and opens the game room.
Development launches use the Python source so backend edits take effect after a restart.
Set `KENTE_USE_EXE_SERVER=1` to exercise the compiled server instead.

For the browser UI without Electron:

```powershell
python batocera/kente-server.py
```

Open `http://localhost:7777`. Serve the app through this server so proxy, download,
and native launch features are available.

## How the pieces fit

| Location | Responsibility |
| --- | --- |
| `index.html`, `style.css` | Room, menus, overlays, and visual design |
| `library.js` | Game metadata, collections, and system colors |
| `js/` | Navigation, controller input, settings, ROM storage, downloads, emulation, theater |
| `batocera/kente-server.py` | HTTP routes, static web assets, streaming, and launch orchestration |
| `batocera/kente_config.py` | Deployment paths, system folders, shared locks, and host lists |
| Other `batocera/kente_*.py` | Emulator setup, BIOS handling, offline cores, network, mods, and cover art |
| `batocera/rom_providers.py`, `batocera/theater_*.py` | External catalog and media providers |
| `electron/` | Desktop window, Python process, IPC bridge, Discord presence, updates |
| `games/flash/`, `vendor/` | Bundled Flash/Ruffle assets and HLS video player |
| `tests/` | Node and Python regression tests |
| `build/`, `batocera/install.sh`, `batocera/custom.sh` | Linux image and kiosk setup tooling |

Frontend files are classic scripts loaded with `defer` in `index.html`. They share a
global scope; loading order matters. Add a script to that list and include it in the
desktop web resources when introducing a new asset directory.

On Batocera, games use the native launch stack. In the Windows desktop app, systems in
`CORE_MAP` run through the bundled or cached EmulatorJS assets. Native systems use
portable emulator copies managed by Kente; their game windows are hosted inside the
Kente player window, with Kente's menu and close controls. The app bundles the portable
engines available to the build, prepares an engine on first use when a download is
available, and can import a portable engine folder through the in-app prompt. These
copies and their writable profiles live under Electron's user data directory, separate
from any emulator already installed on Windows. Flash games use the bundled Ruffle
player.

## Data and offline use

| Mode | ROMs, BIOS, saves, and cache |
| --- | --- |
| Browser server on Windows | Project `roms/`, `bios/`, `saves/`, and `cache/` |
| Electron | `KENTE_DATA_DIR`, set to a `KenteCorner` directory inside Electron's user data folder |
| Batocera/Linux native mode | `/userdata/roms`, `/userdata/bios`, `/userdata/saves`, `/userdata/cache` |
| Browser file storage | User-selected library directory or OPFS at `KenteKorner/roms/{systemId}/` |

IndexedDB stores browser file handles and download history. Browser storage belongs
to the browser profile and origin; changing hostnames or ports creates a different
storage area. External catalogs and streams require a network connection. Browser
emulation also needs a cached or bundled EmulatorJS core for offline play.
If the app closes during a provider search download, the game is retained in the
Download Center as interrupted; choose Retry to search for a source and resume.
Direct-link downloads are not persisted because those links may be temporary.
The Flash asset cache is capped at 2 GB and evicts least recently used assets.

### Back up desktop or Batocera data

The standard-library backup helper archives ROMs, BIOS, saves, portable emulator
profiles, and Kente settings. It excludes rebuildable caches unless requested:

```powershell
python scripts/backup-data.py backup kente-backup.zip --data-dir "$env:APPDATA/KenteCorner"
python scripts/backup-data.py restore kente-backup.zip --data-dir "$env:APPDATA/KenteCorner"
```

Restore refuses to replace files unless `--overwrite` is provided. On Batocera,
use `--data-dir /userdata`. Browser profile data (IndexedDB, OPFS, and directory
handles) is browser-managed and is not included in this archive.

`KENTE_APP_MODE=electron`, `KENTE_DATA_DIR`, and `KENTE_WEB_DIR` select an isolated
server data directory and web root. Electron sets these automatically. The backend
currently treats Linux hosts as native/Batocera deployments by default.

Optional `artkeys.json` supports `discordAppId`, `sgdb`, and `tgdb`; cover art keys can
also come from `SGDB_KEY` and `TGDB_KEY`. Keep this file local; it is gitignored.
The static server serves public web assets and rejects private project files.

## Check changes

```powershell
npm run check:syntax
npm test
```

The syntax check parses application JavaScript and Python files without executing
them. GitHub Actions runs it before the Node and Python regression suites on pushes
and pull requests.

`npm run test:js` runs all `tests/*.test.mjs` files. `npm run test:py` runs Python
unittest discovery. Local HTTP tests use temporary storage, ephemeral loopback ports,
and controlled upstream responses, so they do not install emulators or contact providers.

One optional EmulatorJS test needs a server on port 7777 with the expected Nestopia
core cached; it reports a skip when the server is absent. Automated coverage does
not replace a gameplay check, controller check, or verification of live providers.

## Build the Windows installer

Install PyInstaller in your Python environment and provide a PCSX2 portable install and
Dolphin portable files. The build stages those engines and any detected RPCS3/Flycast
portable installs from the build machine, along with the local Microsoft runtime DLLs
and offline EmulatorJS pack, then rebuilds the backend before packaging:

```powershell
npm run build -- --publish never
```

The installer includes its engine/runtime files, desktop icon, server executable, web
assets, and cached browser cores. ROMs, BIOS/firmware, memory cards, and saves remain in
the app's user data folder. Kente does not copy those user files into the installer.
Engine packages not present on the build machine can be added on first use where a
portable download is available, or imported from a folder in the app. The runtime
dependencies include Discord RPC and the auto-updater.

Desktop builds fetch and validate the EmulatorJS runtime and supported core archives
before packaging them, including the separately hosted Dreamcast core. First builds
therefore need internet access and produce larger installers, but browser-core systems
can start without downloading emulator files after installation. Use `npm run fetch:ejs`
to refresh this cache manually. Console ROMs and firmware/BIOS files remain user-provided.
