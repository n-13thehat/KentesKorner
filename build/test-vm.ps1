#Requires -RunAsAdministrator
<#
.SYNOPSIS
    KenteOS Virtual Machine Tester
.DESCRIPTION
    Creates a Hyper-V VM and boots it from the KenteOS ISO to test the
    bootable drive without needing physical hardware. Falls back to
    VirtualBox if Hyper-V is unavailable.
.PARAMETER IsoPath
    Path to the KenteOS ISO. Defaults to dist/KenteOS-1.0.0-x86_64.iso
.PARAMETER RamMB
    RAM to allocate to the VM in MB. Default: 4096
.PARAMETER DiskGB
    Virtual hard disk size in GB. Default: 32
.EXAMPLE
    .\test-vm.ps1 -IsoPath dist\KenteOS-1.0.0-x86_64.iso -RamMB 8192
#>
param(
    [string]$IsoPath = "$PSScriptRoot\..\dist\KenteOS-1.0.0-x86_64.iso",
    [int]   $RamMB   = 4096,
    [int]   $DiskGB  = 32
)

$VmName  = "KenteOS-Test"
$gold    = "Yellow"
function Write-Gold { param($msg) Write-Host $msg -ForegroundColor $gold }

Write-Gold @"

  KenteOS VM Tester
  ISO  : $IsoPath
  RAM  : ${RamMB} MB
  Disk : ${DiskGB} GB
  VM   : $VmName

"@

if (-not (Test-Path $IsoPath)) {
    Write-Host "[ERROR] ISO not found: $IsoPath" -ForegroundColor Red
    Write-Host "        Build it first with: docker run -v `${PWD}/dist:/output kente-build" -ForegroundColor Red
    exit 1
}

# ── Detect Hyper-V ────────────────────────────────────────────────────────────
$hyperV = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
if ($hyperV -and $hyperV.State -eq 'Enabled') {
    Write-Gold "[*] Using Hyper-V..."

    # Remove previous test VM if it exists
    if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) {
        Write-Gold "[*] Removing previous VM '$VmName'..."
        Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
        Remove-VM -Name $VmName -Force
    }

    # Virtual disk path
    $vhdPath = "$env:USERPROFILE\Documents\$VmName.vhdx"
    if (Test-Path $vhdPath) { Remove-Item $vhdPath -Force }

    Write-Gold "[*] Creating Hyper-V VM '$VmName'..."
    New-VM -Name $VmName `
           -MemoryStartupBytes ([long]$RamMB * 1MB) `
           -Generation 2 `
           -NewVHDPath $vhdPath `
           -NewVHDSizeBytes ([long]$DiskGB * 1GB) `
           -SwitchName (Get-VMSwitch | Select-Object -First 1).Name | Out-Null

    # Configure VM
    Set-VM -Name $VmName -ProcessorCount 4 -AutomaticCheckpointsEnabled $false
    Set-VMFirmware -VMName $VmName -EnableSecureBoot Off
    Set-VMDvdDrive -VMName $VmName -Path (Resolve-Path $IsoPath)

    # Set boot order: DVD first, then disk
    $bootOrder = Get-VMFirmware -VMName $VmName
    $dvd  = $bootOrder.BootOrder | Where-Object { $_.BootType -eq 'Drive' -and $_.Device -like '*DVD*' }
    $disk = $bootOrder.BootOrder | Where-Object { $_.BootType -eq 'Drive' -and $_.Device -like '*HD*'  }
    if ($dvd -and $disk) {
        Set-VMFirmware -VMName $VmName -BootOrder $dvd, $disk
    }

    # Enable nested virtualization for emulator performance
    Set-VMProcessor -VMName $VmName -ExposeVirtualizationExtensions $true -ErrorAction SilentlyContinue

    Write-Gold "[*] Starting VM..."
    Start-VM -Name $VmName
    vmconnect.exe localhost $VmName

    Write-Gold @"

  [OK] KenteOS is booting in Hyper-V!
  The VM window should show the GRUB boot menu.
  Select 'KenteOS' to launch.

  To stop:  Stop-VM -Name '$VmName' -TurnOff -Force
"@

} else {
    # ── Fallback: VirtualBox ──────────────────────────────────────────────────
    $vbox = Get-Command VBoxManage.exe -ErrorAction SilentlyContinue
    if (-not $vbox) {
        Write-Host "[ERROR] Neither Hyper-V nor VirtualBox is available." -ForegroundColor Red
        Write-Host "        Enable Hyper-V: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All" -ForegroundColor Yellow
        Write-Host "        Or install VirtualBox: winget install Oracle.VirtualBox" -ForegroundColor Yellow
        exit 1
    }

    Write-Gold "[*] Using VirtualBox..."
    VBoxManage.exe createvm --name $VmName --ostype Linux_64 --register
    VBoxManage.exe modifyvm $VmName --memory $RamMB --cpus 4 --vram 128 --graphicscontroller vmsvga
    VBoxManage.exe modifyvm $VmName --nic1 nat --boot1 dvd --boot2 disk

    $vdiPath = "$env:USERPROFILE\VirtualBox VMs\$VmName\$VmName.vdi"
    VBoxManage.exe createhd --filename $vdiPath --size ($DiskGB * 1024) --format VDI

    VBoxManage.exe storagectl $VmName --name "IDE" --add ide
    VBoxManage.exe storageattach $VmName --storagectl "IDE" --port 0 --device 0 --type dvddrive --medium (Resolve-Path $IsoPath)
    VBoxManage.exe storageattach $VmName --storagectl "IDE" --port 1 --device 0 --type hdd --medium $vdiPath

    VBoxManage.exe startvm $VmName --type gui
    Write-Gold "[OK] KenteOS booting in VirtualBox!"
}
