#!/bin/bash
# =============================================================================
# KenteOS PS4 Payload Builder
# Downloads a PS4-patched Linux kernel and builds a custom initramfs that
# mounts kente.squashfs from USB and boots KenteOS on a jailbroken PS4.
#
# Requirements: curl, cpio, gzip, find  (standard Linux / WSL)
# Run: bash build/create-ps4-payload.sh
# Output: dist/ps4/{bzImage, initramfs.cpio.gz, bootargs.txt}
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${REPO_ROOT}/dist/ps4"
WORK="/tmp/kente-ps4"
INITRD="${WORK}/initrd"

echo "=== KenteOS PS4 Payload Builder ==="
mkdir -p "${OUTPUT}" "${INITRD}"/{bin,sbin,etc,proc,sys,dev,mnt/usb,mnt/newroot,lib/modules,tmp}

# ── 1. Download PS4-patched Linux kernel ─────────────────────────────────────
echo "[1/3] Downloading PS4 Linux kernel (bzImage)..."
# ps4boot provides FW 5.05–12.02 compatible precompiled bzImage
BZIMAGE_URL="https://github.com/ps4boot/ps4-linux-payloads/releases/latest/download/bzImage"
curl -fsSL --retry 3 --progress-bar "${BZIMAGE_URL}" -o "${OUTPUT}/bzImage" \
    || { echo "  ERROR: bzImage download failed. Check https://github.com/ps4boot/ps4-linux-payloads/releases"; exit 1; }
echo "  -> $(du -sh "${OUTPUT}/bzImage" | cut -f1)  bzImage"

# ── 2. Build initramfs ────────────────────────────────────────────────────────
echo "[2/3] Building KenteOS PS4 initramfs..."

# Static busybox (x86_64 musl) — provides sh, mount, modprobe, switch_root, etc.
BUSYBOX_URL="https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox"
curl -fsSL --retry 3 "${BUSYBOX_URL}" -o "${INITRD}/bin/busybox"
chmod +x "${INITRD}/bin/busybox"

# Install symlinks for all applets we need
for cmd in sh ash ls cat echo mkdir mount umount chmod chown cp mv rm mdev \
           modprobe switch_root sleep insmod lsmod blkid; do
    ln -sf /bin/busybox "${INITRD}/bin/${cmd}" 2>/dev/null || true
done
ln -sf /bin/busybox "${INITRD}/sbin/init" 2>/dev/null || true
ln -sf /bin/busybox "${INITRD}/sbin/mdev" 2>/dev/null || true

# Write the init script
cat > "${INITRD}/init" << 'INIT_SCRIPT'
#!/bin/sh
# KenteOS PS4 init — finds kente.squashfs on USB, switch_root into it
export PATH=/bin:/sbin

mount -t proc     none /proc
mount -t sysfs    none /sys
mount -t devtmpfs none /dev 2>/dev/null || { mount -t tmpfs none /dev; mdev -s; }
mkdir -p /dev/pts
mount -t devpts   none /dev/pts

# Read RTC time passed via kernel cmdline (time=UNIXSECONDS)
for param in $(cat /proc/cmdline); do
    case "$param" in time=*) date -s "@${param#time=}" >/dev/null 2>&1 ;; esac
done

echo "[KenteOS] Loading AMD GCN GPU driver..."
for mod in amdgpu radeon drm drm_kms_helper; do
    modprobe "$mod" 2>/dev/null && echo "  + $mod" || true
done

echo "[KenteOS] Scanning USB drives for kente.squashfs..."
sleep 2

SQUASHFS=""
for dev in /dev/sda /dev/sdb /dev/sdc /dev/sdd /dev/sde; do
    [ -b "$dev" ] || continue
    mount -t vfat "$dev" /mnt/usb 2>/dev/null || \
        mount -t exfat "$dev" /mnt/usb 2>/dev/null || continue
    if [ -f /mnt/usb/kente.squashfs ]; then
        echo "[KenteOS] Found kente.squashfs on $dev"
        SQUASHFS="/mnt/usb/kente.squashfs"
        break
    fi
    umount /mnt/usb 2>/dev/null || true
done

if [ -z "$SQUASHFS" ]; then
    echo "[KenteOS] ERROR: kente.squashfs not found. Dropping to rescue shell."
    exec /bin/sh
fi

# Mount squashfs as new root (read-only lower layer)
mount -t squashfs "$SQUASHFS" /mnt/newroot -o loop

# Overlay: tmpfs upper layer so squashfs root is writable
mkdir -p /tmp/ovl/{upper,work}
mount -t overlay overlay \
    -o "lowerdir=/mnt/newroot,upperdir=/tmp/ovl/upper,workdir=/tmp/ovl/work" \
    /mnt/newroot 2>/dev/null || true   # overlay may not be available — squashfs ro is fine

# Bind the USB mount into new root so KenteOS can read ROMs from it
mkdir -p /mnt/newroot/mnt/usb
mount --bind /mnt/usb /mnt/newroot/mnt/usb 2>/dev/null || true

# Move essential mounts into new root before switching
for mp in proc sys dev; do
    mount --move "/$mp" "/mnt/newroot/$mp" 2>/dev/null || true
done

echo "[KenteOS] Switching root — launching KenteOS..."
exec switch_root /mnt/newroot /sbin/init
INIT_SCRIPT
chmod +x "${INITRD}/init"

# Pack initramfs
echo "  Packing initramfs.cpio.gz..."
cd "${INITRD}"
find . | cpio -H newc -o 2>/dev/null | gzip -9 > "${OUTPUT}/initramfs.cpio.gz"
cd "${REPO_ROOT}"

# ── 3. Kernel command line ────────────────────────────────────────────────────
echo "[3/3] Writing bootargs.txt..."
cat > "${OUTPUT}/bootargs.txt" << 'EOF'
root=/dev/ram0 rw quiet loglevel=3 console=tty0 fbcon=map:0 video=1920x1080@60 drm.debug=0
EOF

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== PS4 Payload Ready ==="
printf "  %-24s %s\n" "bzImage"            "$(du -sh "${OUTPUT}/bzImage"            | cut -f1)"
printf "  %-24s %s\n" "initramfs.cpio.gz"  "$(du -sh "${OUTPUT}/initramfs.cpio.gz"  | cut -f1)"
printf "  %-24s %s\n" "bootargs.txt"       "4 B"
echo ""
echo "  Next: copy dist/ps4/* + dist/KenteOS-*.iso's kente.squashfs"
echo "        to the ROOT of a FAT32 USB drive, then run:"
echo "          build/write-usb.ps1 -Mode PS4"
