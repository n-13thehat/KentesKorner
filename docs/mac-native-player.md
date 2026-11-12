# macOS in-app native player

## Goal

Run a native emulator core in Kente's existing game surface. A game session must
remain owned by Kente: its video is drawn in the player area, audio is routed to
the app, Kente's controller mapping supplies core input, and exit tears down the
core and returns to the existing game HUD. The system browser and a separate
emulator window are not valid fallbacks.

## Architecture

The Mac implementation is an in-process libretro frontend, exposed to Electron
through a macOS Objective-C++ Node addon. Electron's Mac native handle is an
`NSView*`; the addon owns a child `NSView` over the renderer's player rectangle
and keeps it sized from the existing `NativePlayer` resize messages. The core
runs on a dedicated emulation thread. AppKit mutations are dispatched to the
main thread. After mounting, the surface addon passes its child view handle to
the libretro addon, which presents frames into that same view. Exit stops the
core, clears its retained view handle, then removes the surface.
The HUD keeps its startup status visible until the core has submitted its first
video frame, and reports a core startup error or a 60-second frame timeout.

The Mac build creates two Electron addons. The AppKit addon mounts and resizes
the native view. The libretro addon loads a core with `dlopen`, runs it on a
dedicated thread, presents copied software frames on the AppKit main queue,
buffers stereo audio through AudioQueue, polls RetroPad state, and unloads on
exit. Frame pacing follows PCEE2's blocking `retro_run()` call; the host does
not add a second frame timer. Both addons are unpacked from ASAR. The existing
HUD calls the Mac launch, resize, pause/resume, input, status, and stop methods.
PS2 is the only Mac native system currently routed to this host, and only when
the core dylib exists in the packaged resources.

The frontend owns the libretro callbacks and session resources:

- Environment: system/save directories, logging, pixel format, core options,
  input capabilities, and shutdown requests.
- Video: copied CPU frames are presented in the native surface. Kente declines
  libretro hardware-context negotiation because this host does not expose a
  Vulkan device. It selects PCEE2's native Metal renderer on macOS; the core
  owns its Metal device and returns completed frames through its readback path.
- Audio: a fixed-capacity stereo ring feeds short AudioQueue buffers. The host
  reports ring plus queued-buffer occupancy through libretro's audio-buffer
  status callback, which PCEE2 uses for pacing; excess samples are rejected
  instead of growing memory without a bound. Stop gates and drains in-flight
  queue callbacks before flushing the device, preventing callbacks from
  re-enqueuing audio during teardown.
- Input: poll Kente's existing gamepad mapping and expose libretro joypad state.
- ROM preparation: resolve the exact library download, safely extract supported
  archives through Kente's existing extraction cache, then pass the resulting
  disc image path to the core. PS2 discovery and archive selection use the
  pinned PCEE2 core's supported extensions, including `.m3u` playlists and
  `.iso`, `.chd`, `.cue`, `.cso`, `.zso`, `.gz`, `.bin`, `.mdf`, `.nrg`, `.elf`,
  `.irx`, `.gs`, and `.acgame` content. Playlist sessions expose previous/next
  disc controls in the paused HUD through PCEE2's libretro disk-control callbacks.
- Lifecycle: load, pause/resume, resize, stop, error reporting, and cleanup.
  Stopping or replacing a session invalidates pending ROM-resolution and
  archive-preparation requests, so an exited game cannot start later.

The renderer continues to use the existing player HUD and menu. New Electron
IPC methods should mirror its lifecycle, while the macOS addon owns rendering
and core execution. Windows keeps its existing Win32 host.

## First engine target: PlayStation 2

PCEE2's macOS Metal renderer creates its own Metal device and returns frames
through readback, which matches Kente's in-process host. Kente overrides the
core's Vulkan renderer default to `metal`; Vulkan hardware rendering requires
a libretro Vulkan context Kente does not provide. MoltenVK remains bundled for
the core's optional Vulkan path and is validated with the package. The pinned
upstream README reports that its macOS x86_64 build compiles and links but is
untested; the pinned PCSX2 CMake configuration warns that Apple Silicon lacks
the EE, VU, and IOP recompilers, so games will run very slowly there. Kente
builds an Apple Silicon target, but users should expect poor PS2 performance
until upstream completes those recompilers. Treat both architectures as
experimental until gameplay and performance are verified on real hardware.
Kente pins the PCEE2 commit in
`scripts/pcee2-mac-revision.txt`; the build fetches and checks out that exact
commit, independent of later upstream branch movement. Update the pin
deliberately when adopting a new core revision. The exact checked-out source,
GPLv3 license, and matching compiled core are retained in each Mac installer.
Upstream guidance conflicts: the core `.info` metadata says a matching PCSX2 `resources` directory
is required, while the project README says the needed shaders, fonts, game
database, and patches are built in and external resources are optional. The Mac
package includes the source tree's `bin/resources` and merges missing files
into a writable system directory keyed to the exact PCEE2 core revision. This
avoids reusing stale resources after a core update while preserving files
already present for that revision. The core expects user BIOS files under
`pcsx2/bios`; BIOS dumps and other copyrighted firmware must never be bundled.
When PCEE2 reports a missing BIOS, Kente's in-app picker copies the user's
selected `.bin` file into the app's writable BIOS directory and resumes launch.

The Mac build checks out the pinned PCEE2 `libretro` commit, builds the core
and its static dependencies for the runner's architecture, and packages the
exact source checkout used for that build alongside the GPLv3 license.
`BUILD-INFO.txt` records the source and recursive submodule commits and core
checksum. MoltenVK is packaged as the core's optional Vulkan runtime; the build
reads its version from that checkout's `deps.versions`, packages the library,
and records its checksum. The
installer includes the selected core, the MoltenVK library, its matching Apache
2.0 license, and runtime resources, so users do not need to install a separate
emulator or graphics dependency. The MoltenVK release is taken from the bundled
source checkout's dependency lock. The player's system directory points to
Kente's user BIOS directory;
BIOS files are never included in the installer. A Mac build has not yet been
compiled or booted in this Windows workspace, so the frontend's runtime
compatibility, audio behavior, controller mapping, and clean teardown remain
unverified on both Mac architectures. The upstream
project documents its Mac rendering path at
https://github.com/WizzardSK/pcee2-libretro/blob/bf089ed27928fb7d500c68fceabe4f036a7e1caa/README.md
and its Apple Silicon warning in the pinned
https://github.com/WizzardSK/pcee2-libretro/blob/bf089ed27928fb7d500c68fceabe4f036a7e1caa/CMakeLists.txt.
Its source build process is documented at
https://github.com/WizzardSK/pcee2-libretro/blob/bf089ed27928fb7d500c68fceabe4f036a7e1caa/.github/workflows/libretro_builds.yml.

The Mac core build enables Vulkan and uses PCEE2's macOS Metal renderer for
Kente's readback-based frontend. Other cores still need their own compatible
graphics, input, audio, firmware, and runtime-resource paths before Kente can
support them.

## Build and packaging

The Mac release matrix builds the addon and core separately for Intel and Apple
Silicon. Source builds require Xcode command line tools, CMake, Ninja, NASM,
Python 3, and Git; the installer itself includes the emulator runtime. The
addon is built against the Electron headers for the app's Electron
ABI, included in the app bundle, and loaded only on macOS. The core is shipped
under `resources/emulators/<core>/`; writable BIOS, saves, settings, and caches
stay under Electron `userData`.

The build must fail if the addon or the selected core is missing or has the
wrong architecture. Unsigned local builds are suitable for development; a
release must also account for hardened-runtime library loading and notarization.
The packaged-app verifier loads the native addon and PCEE2 core, checks the
core and MoltenVK architectures and recorded checksums, and resolves the
native binaries' linked-library paths inside the app bundle. This catches
packaging and core-loader errors on the Mac build runner; it does not execute
MoltenVK's optional Vulkan path or replace booting a game on Mac hardware.

## System support boundaries

The current browser-core systems remain in EmulatorJS inside Kente. The current
Windows native process host remains Windows-only. On Mac, PS2 is the sole
in-process native target; GameCube/Wii, PS3, Wii U, Xbox, Xbox 360, and Switch
remain unavailable until compatible cores and their frontend requirements are
implemented and verified. Standalone-only engines are not in-app support. SSF
and SSF2 stay in Kente's local Ruffle surface and do not use this native-core
host. External browser launches remain denied by Electron.
