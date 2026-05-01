#!/bin/bash
# =============================================================================
# KenteOS ISO Builder
# Creates a bootable Alpine Linux ISO that auto-launches Kente's Korner.
# Run inside Docker:  docker build -t kente-build . && docker run -v $(pwd)/dist:/output kente-build
# Run on Linux/WSL:   sudo bash create-iso.sh
# =============================================================================
set -euo pipefail

KENTE_VERSION="1.0.0"
ISO_NAME="KenteOS-${KENTE_VERSION}-x86_64.iso"
WORK="${TMPDIR:-/tmp}/kente-build"
OUTPUT="${1:-/output}"
ALPINE_VERSION="3.19"
ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}"
ARCH="x86_64"
EMU_DIR="${WORK}/rootfs/opt/kente/emulators"
APP_DIR="${WORK}/rootfs/opt/kente/app"

echo "=== KenteOS ISO Builder v${KENTE_VERSION} ==="
echo "    Work dir : ${WORK}"
echo "    Output   : ${OUTPUT}/${ISO_NAME}"
mkdir -p "${OUTPUT}" "${WORK}"/{rootfs,iso/boot/grub,iso/EFI/BOOT}

# ── 1. Build Alpine root filesystem ──────────────────────────────────────────
echo "[1/7] Setting up Alpine Linux rootfs..."
MINIROOTFS_URL="${ALPINE_MIRROR}/releases/${ARCH}/alpine-minirootfs-${ALPINE_VERSION}.0-${ARCH}.tar.gz"
curl -fsSL "${MINIROOTFS_URL}" | tar -xz -C "${WORK}/rootfs"

# Configure DNS inside chroot
cp /etc/resolv.conf "${WORK}/rootfs/etc/resolv.conf" 2>/dev/null || true

# ── 2. Install packages into rootfs ──────────────────────────────────────────
echo "[2/7] Installing packages..."
# Bind-mount /proc /sys /dev so chroot commands (npm, etc.) work correctly
mount --bind /proc  "${WORK}/rootfs/proc"
mount --bind /sys   "${WORK}/rootfs/sys"
mount --bind /dev   "${WORK}/rootfs/dev"
trap "umount -lf '${WORK}/rootfs/proc' '${WORK}/rootfs/sys' '${WORK}/rootfs/dev' 2>/dev/null; true" EXIT

chroot "${WORK}/rootfs" /bin/sh -c "
  apk update
  apk add --no-cache \
    linux-lts linux-firmware alpine-base \
    xorg-server xf86-video-fbdev xf86-input-libinput \
    openbox feh \
    nodejs npm python3 py3-pip \
    alsa-utils pulseaudio \
    fuse2 libgl mesa-dri-gallium \
    eudev udev openrc \
    sudo bash curl wget rsync
  # Create kente user (auto-login on tty1)
  adduser -D -s /bin/bash kente
  echo 'kente:kente' | chpasswd
  addgroup kente audio
  addgroup kente video
  addgroup kente input
  # Alpine uses busybox getty; -a flag enables auto-login for a specific user
  sed -i 's|tty1::respawn:/sbin/getty 38400 tty1|tty1::respawn:/sbin/getty -a kente 38400 tty1|' /etc/inittab
"


# ── 3. Copy Kente's Korner application ───────────────────────────────────────
echo "[3/7] Copying Kente's Korner application..."
mkdir -p "${APP_DIR}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rsync -a --exclude=node_modules --exclude=build --exclude=.git \
    "${REPO_ROOT}/" "${APP_DIR}/"
# Full npm install (not --production) so electron devDependency is included.
# We install electron explicitly too in case it's only in devDependencies.
chroot "${WORK}/rootfs" /bin/sh -c "
  cd /opt/kente/app
  npm install 2>&1 | tail -5
  # Ensure electron binary exists and is executable
  test -x node_modules/.bin/electron || npm install electron 2>&1 | tail -3
"

# ── 4. Download emulator AppImages ───────────────────────────────────────────
echo "[4/7] Downloading emulator AppImages..."
mkdir -p "${EMU_DIR}"
declare -A EMU_URLS=(
    ["dolphin"]="https://github.com/dolphin-emu/dolphin/releases/latest/download/dolphin-emu-linux-appimage.AppImage"
    ["pcsx2"]="https://github.com/PCSX2/pcsx2/releases/latest/download/pcsx2-linux.AppImage"
    ["flycast"]="https://github.com/flyinghead/flycast/releases/download/v2.6/flycast-linux-x86_64"
    ["rpcs3"]="https://github.com/RPCS3/rpcs3-binaries-linux/releases/latest/download/rpcs3.AppImage"
    ["cemu"]="https://github.com/cemu-project/Cemu/releases/latest/download/Cemu-2.0-x86_64.AppImage"
)
for emu in "${!EMU_URLS[@]}"; do
    dest="${EMU_DIR}/${emu}.AppImage"
    echo "  -> Downloading ${emu}..."
    curl -fsSL --retry 3 -o "${dest}" "${EMU_URLS[$emu]}" && chmod +x "${dest}" \
        || echo "  WARNING: ${emu} download failed — will be fetched at first boot"
done

# ── 5. Overlay config + auto-start ───────────────────────────────────────────
echo "[5/7] Applying overlay configs..."
[ -d "overlay/" ] && cp -a overlay/. "${WORK}/rootfs/"
KHOME="${WORK}/rootfs/home/kente"
mkdir -p "${KHOME}"
cat > "${KHOME}/.profile" << 'PROFILE'
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    exec startx > /tmp/kente-x.log 2>&1
fi
PROFILE
cat > "${KHOME}/.xinitrc" << 'XINITRC'
#!/bin/sh
xset -dpms; xset s off; xrandr --auto
openbox &
sleep 1
cd /opt/kente/app
python3 batocera/kente-server.py &
sleep 2
# Use the locally installed electron binary — never fetch from internet at boot
exec node_modules/.bin/electron . --no-sandbox
XINITRC
chmod +x "${KHOME}/.xinitrc"
chroot "${WORK}/rootfs" chown -R kente:kente /home/kente

# ── 6. GRUB bootloader (EFI + legacy BIOS) ───────────────────────────────────
echo "[6/7] Configuring GRUB..."
KERNEL_VER=$(ls "${WORK}/rootfs/boot/vmlinuz-"* 2>/dev/null | head -1 | sed 's/.*vmlinuz-//')
KERNEL_VER="${KERNEL_VER:-lts}"
cat > "${WORK}/iso/boot/grub/grub.cfg" << GRUBCFG
set timeout=3
set default=0
menuentry "KenteOS ${KENTE_VERSION}" {
    linux  /boot/vmlinuz-${KERNEL_VER} modules=loop,squashfs,sd-mod,usb-storage quiet loglevel=0 console=tty1
    initrd /boot/initramfs-${KERNEL_VER}
}
menuentry "KenteOS (verbose)" {
    linux  /boot/vmlinuz-${KERNEL_VER} modules=loop,squashfs,sd-mod,usb-storage console=tty1
    initrd /boot/initramfs-${KERNEL_VER}
}
menuentry "Boot from hard drive" { chainloader +1 }
GRUBCFG
cp "${WORK}/rootfs/boot/vmlinuz-${KERNEL_VER}" "${WORK}/iso/boot/"
cp "${WORK}/rootfs/boot/initramfs-${KERNEL_VER}" "${WORK}/iso/boot/"
mksquashfs "${WORK}/rootfs" "${WORK}/iso/kente.squashfs" -comp xz -Xbcj x86 -noappend -quiet
grub-mkstandalone --format=x86_64-efi \
    --output="${WORK}/iso/EFI/BOOT/BOOTX64.EFI" \
    --modules="part_gpt part_msdos fat iso9660 linux normal echo all_video" \
    "boot/grub/grub.cfg=${WORK}/iso/boot/grub/grub.cfg"
grub-mkstandalone --format=i386-pc \
    --output="${WORK}/bios.img" \
    --install-modules="linux normal iso9660 biosdisk memdisk search tar ls" \
    --modules="linux normal iso9660 biosdisk search" \
    "boot/grub/grub.cfg=${WORK}/iso/boot/grub/grub.cfg"
cat /usr/lib/grub/i386-pc/cdboot.img "${WORK}/bios.img" > "${WORK}/iso/boot/grub/bios.img"

# ── 7. Pack into ISO ──────────────────────────────────────────────────────────
echo "[7/7] Creating ISO..."
xorriso -as mkisofs -iso-level 3 -full-iso9660-filenames -volid "KENTE_OS" \
    -eltorito-boot boot/grub/bios.img -no-emul-boot -boot-load-size 4 -boot-info-table \
    --efi-boot EFI/BOOT/BOOTX64.EFI -efi-boot-part --efi-boot-image \
    -o "${OUTPUT}/${ISO_NAME}" "${WORK}/iso"
echo "=== ISO READY: ${OUTPUT}/${ISO_NAME} $(du -sh ${OUTPUT}/${ISO_NAME} | cut -f1) ==="

# Also export a standalone kente.squashfs so the PS4 write-usb mode can copy it
echo "[+] Exporting standalone kente.squashfs for PS4 USB mode..."
cp "${WORK}/iso/kente.squashfs" "${OUTPUT}/kente.squashfs"

echo ""
echo "PC  USB : build/write-usb.ps1 -IsoPath ${OUTPUT}/${ISO_NAME} -Mode PC"
echo "PS4 USB : build/write-usb.ps1 -IsoPath ${OUTPUT}/${ISO_NAME} -Mode PS4"
echo "Both    : build/write-usb.ps1 -IsoPath ${OUTPUT}/${ISO_NAME} -Mode Both"
