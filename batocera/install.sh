#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  KENTE'S KORNER — BATOCERA SETUP SCRIPT
#
#  Run ONCE after flashing Batocera to a USB drive.
#  Can be run from inside Batocera (SSH or terminal) or from the
#  Batocera network share after copying files to the share root.
#
#  Usage:
#    bash /userdata/kente/install.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

KENTE_DIR="/userdata/kente"
SYSTEM_DIR="/userdata/system"
BIOS_DIR="/userdata/bios"
ROMS_DIR="/userdata/roms"
CONF="$SYSTEM_DIR/batocera.conf"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   KENTE'S KORNER — SETUP v1.0        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Create directory structure ───────────────────────────────
echo "[1/6] Creating directories..."
mkdir -p "$KENTE_DIR/logs"
mkdir -p "$KENTE_DIR/splash"
mkdir -p "$BIOS_DIR"

# ROM folders — one per Batocera system name
ROM_SYSTEMS=(
    nes gb mastersystem atari2600 atari7800 gamegear
    snes megadrive gbc gba pcengine neogeo
    n64 psx saturn dreamcast megacd sega32x
    nds psp ps2 gamecube wii wiiu
    xbox xbox360 ps3 switch
)
for sys in "${ROM_SYSTEMS[@]}"; do
    mkdir -p "$ROMS_DIR/$sys"
done
echo "    ✓ ROM folders created"

# ── 2. Install boot script ───────────────────────────────────────
echo "[2/6] Installing boot script..."
cp "$KENTE_DIR/custom.sh" "$SYSTEM_DIR/custom.sh"
chmod +x "$SYSTEM_DIR/custom.sh"
echo "    ✓ /userdata/system/custom.sh installed"

# ── 3. Patch batocera.conf ───────────────────────────────────────
echo "[3/6] Patching batocera.conf..."
touch "$CONF"

patch_conf() {
    local key="$1" val="$2"
    if grep -q "^${key}=" "$CONF" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$CONF"
    else
        echo "${key}=${val}" >> "$CONF"
    fi
}

# Disable EmulationStation auto-start — Kente's Korner takes its place
patch_conf "system.es.atstartup"    "0"
# Keep virtual keyboard available for text input
patch_conf "system.virtual_keyboard" "1"
# Ensure X server starts (required for Chromium)
patch_conf "system.startx"          "1"

echo "    ✓ batocera.conf patched"

# ── 4. BIOS check ───────────────────────────────────────────────
echo "[4/6] Checking BIOS files..."
BIOS_NEEDED=(
    "scph1001.bin     → PlayStation 1"
    "saturn_bios.bin  → Sega Saturn"
    "dc_boot.bin      → Dreamcast"
    "dc_flash.bin     → Dreamcast"
    "gba_bios.bin     → Game Boy Advance (optional)"
    "neogeo.zip       → Neo Geo"
)
MISSING=0
for entry in "${BIOS_NEEDED[@]}"; do
    fname=$(echo "$entry" | awk '{print $1}')
    label=$(echo "$entry" | cut -d'→' -f2)
    if [ -f "$BIOS_DIR/$fname" ]; then
        echo "    ✓ $fname"
    else
        echo "    ✗ $fname  ($label) — MISSING"
        MISSING=$((MISSING + 1))
    fi
done
if [ "$MISSING" -gt 0 ]; then
    echo ""
    echo "    ⚠  $MISSING BIOS file(s) missing."
    echo "    Copy them to: $BIOS_DIR"
    echo "    Source: github.com/BatoceraPLUS/Batocera.PLUS-bios"
fi

# ── 5. Splash placeholder ────────────────────────────────────────
echo "[5/6] Splash setup..."
if [ ! -f "$KENTE_DIR/splash/splash.mp4" ]; then
    echo "    ⚠  No splash.mp4 found at $KENTE_DIR/splash/"
    echo "    Place your Kente's Korner boot video there."
else
    echo "    ✓ Splash video found"
fi

# ── 6. Done ──────────────────────────────────────────────────────
echo "[6/6] Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Add BIOS files to  $BIOS_DIR"
echo "  2. Add ROMs to        $ROMS_DIR/<system>/"
echo "  3. Add splash video to $KENTE_DIR/splash/splash.mp4"
echo "  4. Reboot — Kente's Korner will launch automatically"
echo ""
echo "╔══════════════════════════════════════╗"
echo "║   READY. REBOOT TO ENTER THE ROOM.   ║"
echo "╚══════════════════════════════════════╝"
echo ""

