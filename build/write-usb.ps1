#Requires -RunAsAdministrator
<#
.SYNOPSIS
    KenteOS Bootable USB Writer
.DESCRIPTION
    Writes the KenteOS ISO to a USB drive, making it bootable from any PC's boot menu.
    Supports both UEFI and legacy BIOS boot.
.PARAMETER IsoPath
    Path to the KenteOS ISO file. Defaults to dist/KenteOS-1.0.0-x86_64.iso
.PARAMETER DriveLetter
    Target USB drive letter (e.g. E). If not specified, shows a picker.
.EXAMPLE
    .\write-usb.ps1 -IsoPath dist\KenteOS-1.0.0-x86_64.iso
#>
param(
    [string]$IsoPath     = "$PSScriptRoot\..\dist\KenteOS-1.0.0-x86_64.iso",
    [string]$DriveLetter = "",
    # Mode: PC  = raw ISO dd (best PC UEFI/BIOS compatibility)
    #       PS4 = FAT32 format + PS4 boot files (GoldHEN kexec payload)
    #       Both= FAT32 format + GRUB via WSL + PC and PS4 files on one drive
    [ValidateSet("PC","PS4","Both")]
    [string]$Mode        = "PC"
)

$Host.UI.RawUI.WindowTitle = "KenteOS USB Writer [$Mode mode]"
$gold = "Yellow"

function Write-Gold { param($msg) Write-Host $msg -ForegroundColor $gold }

Write-Gold @"

  ██╗  ██╗███████╗███╗   ██╗████████╗███████╗ ██████╗ ███████╗
  ██║ ██╔╝██╔════╝████╗  ██║╚══██╔══╝██╔════╝██╔═══██╗██╔════╝
  █████╔╝ █████╗  ██╔██╗ ██║   ██║   █████╗  ██║   ██║███████╗
  ██╔═██╗ ██╔══╝  ██║╚██╗██║   ██║   ██╔══╝  ██║   ██║╚════██║
  ██║  ██╗███████╗██║ ╚████║   ██║   ███████╗╚██████╔╝███████║
  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝ ╚═════╝ ╚══════╝
                    BOOTABLE USB WRITER
"@

# ── 0. Mode banner ────────────────────────────────────────────────────────────
Write-Gold "  Mode: $Mode"
Write-Gold "  PC   = UEFI/BIOS bootable ISO (for computers)"
Write-Gold "  PS4  = FAT32 + PS4 Linux payload (for jailbroken PS4 FW 5.05-12.02)"
Write-Gold "  Both = FAT32 + GRUB + PS4 files (one drive, works everywhere)`n"

# ── 1. Validate files ─────────────────────────────────────────────────────────
$PS4Dir   = "$PSScriptRoot\..\dist\ps4"
$needISO  = $Mode -in @("PC","Both")
$needPS4  = $Mode -in @("PS4","Both")

if ($needISO) {
    if (-not (Test-Path $IsoPath)) {
        Write-Host "[ERROR] ISO not found: $IsoPath" -ForegroundColor Red
        Write-Host "        Build it first: cd build && docker build -t kente-build . && docker run -v `${PWD}/../dist:/output kente-build" -ForegroundColor Red
        exit 1
    }
    $isoSize = [math]::Round((Get-Item $IsoPath).Length / 1GB, 2)
    Write-Gold "[OK] PC ISO  : $IsoPath ($isoSize GB)"
}
if ($needPS4) {
    $bzImage   = "$PS4Dir\bzImage"
    $initramfs = "$PS4Dir\initramfs.cpio.gz"
    if (-not (Test-Path $bzImage) -or -not (Test-Path $initramfs)) {
        Write-Host "[ERROR] PS4 payload files not found in dist\ps4\" -ForegroundColor Red
        Write-Host "        Build them first (in WSL): bash build/create-ps4-payload.sh" -ForegroundColor Red
        exit 1
    }
    Write-Gold "[OK] PS4 bzImage : $bzImage"
    Write-Gold "[OK] PS4 initramfs: $initramfs"
}

# ── 2. Pick USB drive ─────────────────────────────────────────────────────────
$removable = Get-Disk | Where-Object { $_.BusType -in 'USB','SD' -and $_.Size -gt 1GB }
if ($removable.Count -eq 0) {
    Write-Host "[ERROR] No USB drives detected. Insert a USB drive and try again." -ForegroundColor Red
    exit 1
}

Write-Gold "`nAvailable USB drives:"
$removable | ForEach-Object {
    $gb = [math]::Round($_.Size / 1GB, 1)
    Write-Host ("  Disk {0}  {1,-30}  {2} GB" -f $_.Number, $_.FriendlyName, $gb)
}

$diskNumRaw = Read-Host "`nEnter Disk Number to write KenteOS to (DATA WILL BE ERASED)"
# Strict parse — reject "5abc" (would silently truncate to 5 with [int])
$diskNum = 0
if (-not [int]::TryParse($diskNumRaw, [ref]$diskNum)) {
    Write-Host "[ERROR] Disk number must be a whole integer." -ForegroundColor Red; exit 1
}
$target  = $removable | Where-Object { $_.Number -eq $diskNum }
if (-not $target) {
    Write-Host "[ERROR] Invalid disk number." -ForegroundColor Red; exit 1
}

$confirm = Read-Host "Type YES to erase Disk $diskNum and write KenteOS"
if ($confirm -ne "YES") { Write-Host "Cancelled."; exit 0 }

# ── 3. Write to USB ──────────────────────────────────────────────────────────
$wslAvail = Get-Command wsl.exe -ErrorAction SilentlyContinue
$diskLtr  = [char](97 + $diskNum)               # Disk 1 → 'b', Disk 2 → 'c', etc.
$wslDev   = "/dev/sd${diskLtr}"

# Helper: FAT32 format via diskpart (used by PS4 and Both modes)
function Format-UsbFat32 {
    param([int]$Num)
    Write-Gold "[*] Formatting Disk $Num as FAT32 (KENTE_OS)..."
    # Note: here-string "@" must be at column-0; use string join instead to be safe inside a function
    $dp = ("select disk $Num", "clean", "create partition primary",
           "select partition 1", "active",
           "format fs=fat32 quick label=KENTE_OS", "assign", "exit") -join "`r`n"
    $dp | diskpart | Out-Null
    Start-Sleep 2
    (Get-Partition -DiskNumber $Num -ErrorAction SilentlyContinue | Get-Volume -ErrorAction SilentlyContinue).DriveLetter
}

if ($Mode -eq "PC") {
    # ── PC: raw ISO dd - best UEFI+BIOS compatibility ────────────────────────
    Write-Gold "`n[*] PC MODE: Writing ISO to Disk $diskNum (raw dd)..."
    if ($wslAvail) {
        $isoWsl = (wsl wslpath ($IsoPath.Replace('\','/'))) 2>$null
        # Reject paths containing shell metacharacters or whitespace before
        # passing them to `wsl sudo dd` — defence against a malicious
        # -IsoPath argument ($, `, ;, |, &, etc) executing inside the WSL
        # shell, and against word-splitting on spaces.
        if ($isoWsl -and ($isoWsl -notmatch '[`$;|&<>"''()\n\r\t ]')) {
            wsl sudo dd "if=$isoWsl" "of=${wslDev}" bs=4M status=progress oflag=sync
            Write-Gold "[OK] ISO written via WSL dd!"
        } elseif ($isoWsl) {
            Write-Host "[ERROR] ISO path contains unsafe characters: $isoWsl" -ForegroundColor Red
            exit 1
        }
    } else {
        $rufus = Get-Command rufus.exe -ErrorAction SilentlyContinue
        if ($rufus) {
            Start-Process rufus.exe -ArgumentList "--drive=$diskNum --image=`"$IsoPath`" --format=MBR" -Wait
        } else {
            Write-Host "[WARN] WSL + Rufus not found. Mount-and-copy fallback (may not boot on all PCs)." -ForegroundColor Yellow
            $drv = Format-UsbFat32 $diskNum
            $mnt = Mount-DiskImage -ImagePath (Resolve-Path $IsoPath) -PassThru
            $src = ($mnt | Get-Volume).DriveLetter
            robocopy "${src}:\" "${drv}:\" /E /NFL /NDL /NJH /NJS | Out-Null
            Dismount-DiskImage -ImagePath (Resolve-Path $IsoPath) | Out-Null
            Write-Gold "[OK] ISO contents copied (install WSL for full raw-write support)."
        }
    }

} elseif ($Mode -eq "PS4") {
    # ── PS4: FAT32 + PS4 kernel + initramfs ──────────────────────────────────
    Write-Gold "`n[*] PS4 MODE: Formatting Disk $diskNum as FAT32 + copying PS4 payload..."
    $drv = Format-UsbFat32 $diskNum
    if (-not $drv) { Write-Host "[ERROR] Could not assign drive letter." -ForegroundColor Red; exit 1 }
    Write-Gold "[*] Copying PS4 payload to ${drv}:\ ..."
    Copy-Item "$PS4Dir\bzImage"           "${drv}:\"
    Copy-Item "$PS4Dir\initramfs.cpio.gz" "${drv}:\"
    Copy-Item "$PS4Dir\bootargs.txt"      "${drv}:\"
    # Also copy kente.squashfs from ISO so PS4 initramfs can mount it
    $squash = "$PSScriptRoot\..\dist\kente.squashfs"
    if (Test-Path $squash) { Copy-Item $squash "${drv}:\" ; Write-Gold "  + kente.squashfs" }
    else { Write-Host "[WARN] kente.squashfs not found - build the ISO first so PS4 can load KenteOS." -ForegroundColor Yellow }
    Write-Gold "[OK] PS4 payload ready on ${drv}:\"

} else {
    # ── Both: FAT32 + GRUB via WSL + ISO contents + PS4 files ───────────────
    Write-Gold "`n[*] BOTH MODE: FAT32 + GRUB + PS4 payload (requires WSL with grub-install)..."
    $drv = Format-UsbFat32 $diskNum
    if (-not $drv) { Write-Host "[ERROR] Could not assign drive letter." -ForegroundColor Red; exit 1 }

    # Install GRUB to MBR + EFI via WSL
    if ($wslAvail) {
        $usbWsl = "/dev/sd${diskLtr}1"
        $mntPt  = "/mnt/kente_usb_$$"
        Write-Gold "[*] Installing GRUB to ${wslDev} via WSL..."
        wsl bash -c "apt-get install -y --quiet grub-pc grub-efi-amd64-bin >/dev/null 2>&1; mkdir -p ${mntPt}; mount ${usbWsl} ${mntPt}; grub-install --target=i386-pc --boot-directory=${mntPt}/boot ${wslDev}; grub-install --target=x86_64-efi --boot-directory=${mntPt}/boot --efi-directory=${mntPt} --removable ${wslDev}; umount ${mntPt}" 2>&1
        Write-Gold "[OK] GRUB installed."
    } else {
        Write-Host "[WARN] WSL not available - GRUB not installed. PC boot may not work." -ForegroundColor Yellow
    }
    # Copy PC ISO contents (kernel, initramfs, squashfs, GRUB config)
    Write-Gold "[*] Copying KenteOS PC boot files..."
    $mnt = Mount-DiskImage -ImagePath (Resolve-Path $IsoPath) -PassThru
    $src = ($mnt | Get-Volume).DriveLetter
    robocopy "${src}:\" "${drv}:\" /E /NFL /NDL /NJH /NJS | Out-Null
    Dismount-DiskImage -ImagePath (Resolve-Path $IsoPath) | Out-Null
    # Copy PS4 payload files to root
    Write-Gold "[*] Copying PS4 payload files..."
    Copy-Item "$PS4Dir\bzImage"           "${drv}:\"
    Copy-Item "$PS4Dir\initramfs.cpio.gz" "${drv}:\"
    Copy-Item "$PS4Dir\bootargs.txt"      "${drv}:\"
    Write-Gold "[OK] Both-mode USB ready on ${drv}:\"
}

# ── 4. Success ────────────────────────────────────────────────────────────────
Write-Gold @"

  =====================================================
   KenteOS USB - READY!   [Mode: $Mode]
   =====================================================

   PC BOOT:
     1. Insert USB into any computer
     2. Press F8/F9/F11/F12 (or Del) at power-on
     3. Select USB / UEFI USB from the boot menu
     4. Choose 'KenteOS' from the GRUB menu

   PS4 BOOT (FW 5.05 to 12.02, jailbreak required):
     1. Install GoldHEN on your PS4 (PPPwn or existing jailbreak)
     2. Plug this USB into the PS4
     3. In GoldHEN BinLoader, visit: https://ps4boot.github.io
        or load the Linux payload .elf for your firmware
     4. The payload detects the USB and boots KenteOS automatically

  =====================================================
"@
