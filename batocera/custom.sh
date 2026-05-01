#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  KENTE'S KORNER — BATOCERA BOOT SCRIPT
#  /userdata/system/custom.sh
#
#  Replaces Batocera's EmulationStation with the Kente shell.
#  Boot order:
#    1. Kente Server starts (Python, port 7777)
#    2. Chromium launches in kiosk mode → localhost:7777
#    3. EmulationStation is blocked — user only sees Kente's Korner
# ═══════════════════════════════════════════════════════════════

KENTE_DIR="/userdata/kente"
LOG_DIR="$KENTE_DIR/logs"
mkdir -p "$LOG_DIR"

echo "[Kente Boot] $(date) — Starting Kente's Korner" >> "$LOG_DIR/boot.log"

# ── 1. Kill EmulationStation if it's running ────────────────────
# (Batocera may still try to start it depending on version)
pkill -f emulationstation 2>/dev/null || true

# ── 2. Set up display environment ───────────────────────────────
export DISPLAY=:0
export XAUTHORITY=/var/run/.Xauthority

# Wait for X server to be ready
for i in $(seq 1 15); do
    xdpyinfo >/dev/null 2>&1 && break
    sleep 1
done

# ── 3. Start Kente Server in background ─────────────────────────
# Server boots in parallel while Chromium shows the branded splash.
cd "$KENTE_DIR"
python3 "$KENTE_DIR/kente-server.py" \
    >> "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "[Kente Boot] Server PID: $SERVER_PID" >> "$LOG_DIR/boot.log"

# ── 4. Launch Chromium immediately at the branded splash ─────────
# splash.html shows Kente's Korner animation and POLLS localhost:7777
# internally — it transitions to the app the moment the server is up.
# The user sees the brand from the very first frame. No black screen.
chromium-browser \
    --kiosk \
    --no-sandbox \
    --disable-infobars \
    --disable-translate \
    --disable-features=TranslateUI,OverscrollHistoryNavigation \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --no-first-run \
    --disable-default-apps \
    --disable-popup-blocking \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --check-for-update-interval=31536000 \
    --allow-file-access-from-files \
    --app="file:///userdata/kente/splash.html" \
    >> "$LOG_DIR/chromium.log" 2>&1 &

CHROMIUM_PID=$!
echo "[Kente Boot] Chromium PID: $CHROMIUM_PID" >> "$LOG_DIR/boot.log"
echo "[Kente Boot] Splash active — server and UI booting in parallel" >> "$LOG_DIR/boot.log"

# ── 5. Watchdog — restart Chromium if it ever dies ──────────────
while true; do
    sleep 5
    if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
        echo "[Kente Watchdog] $(date) — Chromium died, restarting" >> "$LOG_DIR/boot.log"
        chromium-browser \
            --kiosk --no-sandbox --disable-infobars \
            --app=http://localhost:7777 \
            >> "$LOG_DIR/chromium.log" 2>&1 &
        CHROMIUM_PID=$!
    fi
done

