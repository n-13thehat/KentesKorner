#Requires -Version 5.1
<#
  Kente's Korner — Launcher with Auto-Update
  ------------------------------------------
  Double-click the desktop shortcut to:
    1. Pull the latest code from GitHub
    2. Install any new Node dependencies
    3. Start the Electron app
#>

$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot   # same folder this script lives in

# ── Splash window ─────────────────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$splash            = New-Object System.Windows.Forms.Form
$splash.Text       = "Kente's Korner"
$splash.Size       = New-Object System.Drawing.Size(440, 200)
$splash.StartPosition = 'CenterScreen'
$splash.FormBorderStyle = 'None'
$splash.BackColor  = [System.Drawing.ColorTranslator]::FromHtml('#070810')
$splash.TopMost    = $true

$icoPath = Join-Path $ProjectDir 'resources\KenteCorner.ico'
if (Test-Path $icoPath) { $splash.Icon = New-Object System.Drawing.Icon($icoPath) }

$title             = New-Object System.Windows.Forms.Label
$title.Text        = "KENTE'S KORNER"
$title.Font        = New-Object System.Drawing.Font('Consolas', 18, [System.Drawing.FontStyle]::Bold)
$title.ForeColor   = [System.Drawing.ColorTranslator]::FromHtml('#ffc400')
$title.TextAlign   = 'MiddleCenter'
$title.Dock        = 'Top'
$title.Height      = 70

$status            = New-Object System.Windows.Forms.Label
$status.Text       = 'INITIALISING...'
$status.Font       = New-Object System.Drawing.Font('Consolas', 9)
$status.ForeColor  = [System.Drawing.ColorTranslator]::FromHtml('#888888')
$status.TextAlign  = 'MiddleCenter'
$status.Dock       = 'Fill'

$splash.Controls.AddRange(@($title, $status))
$splash.Show()
$splash.Refresh()

function Set-Status($msg) {
    $status.Text = $msg
    $splash.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

# ── Update ────────────────────────────────────────────────────────────────────
Set-Location $ProjectDir

Set-Status 'CHECKING FOR UPDATES...'
try {
    $gitOut = git pull 2>&1 | Out-String
    if ($gitOut -match 'Already up to date') {
        Set-Status 'UP TO DATE.'
    } elseif ($gitOut -match 'error|fatal') {
        Set-Status 'UPDATE CHECK SKIPPED (OFFLINE OR NO COMMITS YET).'
    } else {
        Set-Status 'UPDATE APPLIED — RELOADING DEPENDENCIES...'
        & npm install --silent 2>&1 | Out-Null
        Set-Status 'DEPENDENCIES READY.'
    }
} catch {
    Set-Status 'COULD NOT REACH GITHUB — LAUNCHING CURRENT VERSION.'
}

Start-Sleep -Milliseconds 600

# ── Launch ────────────────────────────────────────────────────────────────────
Set-Status 'LAUNCHING...'
Start-Sleep -Milliseconds 400

$splash.Close()
$splash.Dispose()

Set-Location $ProjectDir
& npm start
